import { LightningElement, api, wire, track } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { refreshApex } from '@salesforce/apex';
import LightningConfirm from 'lightning/confirm';
import CASE_ACCOUNT_ID from '@salesforce/schema/Case.AccountId';
import getFinancialAccounts from '@salesforce/apex/TransferConfigurationController.getFinancialAccounts';
import searchFinancialAccounts from '@salesforce/apex/TransferConfigurationController.searchFinancialAccounts';
import getTransferSummary from '@salesforce/apex/TransferConfigurationController.getTransferSummary';
import saveTransferRequests from '@salesforce/apex/TransferConfigurationController.saveTransferRequests';
import deleteTransferRequests from '@salesforce/apex/TransferConfigurationController.deleteTransferRequests';

const CASE_FIELDS = [CASE_ACCOUNT_ID];

export default class TransferConfiguration extends LightningElement {
    @api recordId;
    @api objectApiName;

    @track isFormMode = false;
    @track sourceSelected = [];
    @track destinationSelected = [];
    @track transferDate;
    @track isLoading = false;
    @track error;

    @track destSearchTerm = '';
    @track _destSearchRawResults = [];
    isSearchingDest = false;

    sourceComboboxValue = '';
    _keyCounter = 0;
    _destSearchTimeout;

    @wire(getRecord, { recordId: '$recordId', fields: CASE_FIELDS })
    wiredCase;

    @wire(getTransferSummary, { caseId: '$caseId' })
    wiredSummary;

    @wire(getFinancialAccounts, { accountId: '$effectiveAccountId' })
    wiredFinancialAccounts;

    get caseId() {
        return this.objectApiName === 'Case' ? this.recordId : null;
    }

    get effectiveAccountId() {
        if (this.objectApiName === 'Case') {
            return getFieldValue(this.wiredCase?.data, CASE_ACCOUNT_ID);
        }
        return this.recordId;
    }

    get summary() {
        const raw = this.wiredSummary?.data;
        if (!raw) return null;
        return {
            ...raw,
            sources: raw.sources.map((s) => ({
                ...s,
                displayLabel: `${s.accountType} • ****${s.accountNumber?.slice(-4)}`
            })),
            destinations: raw.destinations.map((d) => ({
                ...d,
                displayLabel: `${d.accountType} • ****${d.accountNumber?.slice(-4)}`
            }))
        };
    }

    get hasTransferSummary() {
        return this.summary != null;
    }

    get financialAccounts() {
        return this.wiredFinancialAccounts?.data ?? [];
    }

    // Accounts not yet selected in either column, sorted by balance descending.
    // Both comboboxes read from this single computed list.
    get availableOptions() {
        const selectedIds = new Set([
            ...this.sourceSelected.map((r) => r.id),
            ...this.destinationSelected.map((r) => r.id)
        ]);
        return this.financialAccounts
            .filter((fa) => !selectedIds.has(fa.id))
            .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))
            .map((fa) => ({ label: this._formatAccountLabel(fa), value: fa.id }));
    }

    // Search results with anything already selected on either side filtered out,
    // so an account can't be picked twice or used as both a source and a destination.
    get destSearchResults() {
        const excludedIds = new Set([
            ...this.sourceSelected.map((r) => r.id),
            ...this.destinationSelected.map((r) => r.id)
        ]);
        return this._destSearchRawResults
            .filter((fa) => !excludedIds.has(fa.id))
            .map((fa) => ({
                id: fa.id,
                displayLabel: `${fa.name} • ****${fa.financialAccountNumber?.slice(-4) ?? '????'}`
            }));
    }

    get hasDestSearchResults() {
        return this.destSearchResults.length > 0;
    }

    get hasSourceAccounts() {
        return this.sourceSelected.length > 0;
    }

    get hasDestinationAccounts() {
        return this.destinationSelected.length > 0;
    }

    // Amount is only meaningfully entered on one side for 1:1, N:1 and 1:N —
    // the other side's single account always carries the matching total, so we
    // derive it instead of asking the user to re-key (and possibly mismatch) it.
    // N:N is the only shape where both sides need independent amounts.
    //
    // The shape is ambiguous while either side is still empty (e.g. one source
    // and zero destinations could become 1:1 or 1:N), so both sides stay
    // editable until there's at least one account on each — only then do we
    // know which side's total to derive.
    get _shapeIsResolved() {
        return this.sourceSelected.length > 0 && this.destinationSelected.length > 0;
    }

    get sourceAmountEditable() {
        if (!this._shapeIsResolved) return true;
        return !(this.sourceSelected.length === 1 && this.destinationSelected.length > 1);
    }

    get destinationAmountEditable() {
        if (!this._shapeIsResolved) return true;
        return this.destinationSelected.length > 1;
    }

    get sourceTotal() {
        if (!this.sourceAmountEditable) {
            return this.destinationTotal;
        }
        return this.sourceSelected.reduce((sum, r) => sum + this._parseAmount(r.amount), 0);
    }

    get destinationTotal() {
        if (!this.destinationAmountEditable) {
            return this.sourceTotal;
        }
        return this.destinationSelected.reduce((sum, r) => sum + this._parseAmount(r.amount), 0);
    }

    get hasTotalMismatch() {
        return this.sourceTotal > 0 && this.destinationTotal > 0 && this.sourceTotal !== this.destinationTotal;
    }

    // --- List mode handlers ---

    handleNew() {
        this.isFormMode = true;
    }

    handleEdit() {
        if (this.summary) {
            this.transferDate = this.summary.transferDate;

            this.sourceSelected = this.summary.sources.map((s) => {
                const fa = this.financialAccounts.find((a) => a.id === s.recordId);
                return {
                    _key: ++this._keyCounter,
                    id: s.recordId,
                    name: s.accountName,
                    lastFour: s.accountNumber?.slice(-4) ?? '????',
                    balance: fa?.balance ?? null,
                    amount: s.amount
                };
            });

            this.destinationSelected = this.summary.destinations.map((d) => {
                const fa = this.financialAccounts.find((a) => a.id === d.recordId);
                return {
                    _key: ++this._keyCounter,
                    id: d.recordId,
                    name: d.accountName,
                    lastFour: d.accountNumber?.slice(-4) ?? '????',
                    balance: fa?.balance ?? null,
                    amount: d.amount
                };
            });
        }
        this.isFormMode = true;
    }

    async handleReset() {
        const confirmed = await LightningConfirm.open({
            label: 'Reset Transfer Requests',
            message: 'This will permanently delete all transfer request records for this case. This cannot be undone.',
            theme: 'warning'
        });
        if (!confirmed) return;

        this.isLoading = true;
        try {
            await deleteTransferRequests({ caseId: this.recordId });
            await refreshApex(this.wiredSummary);
            this.dispatchEvent(
                new ShowToastEvent({ title: 'Deleted', message: 'Transfer requests have been removed.', variant: 'success' })
            );
        } catch (e) {
            this.error = this._extractError(e);
        } finally {
            this.isLoading = false;
        }
    }

    // --- Form mode: account selection ---

    handleAddSource(event) {
        const id = event.detail.value;
        if (!id) return;
        const fa = this.financialAccounts.find((a) => a.id === id);
        if (!fa) return;
        this.sourceSelected = [...this.sourceSelected, this._makeRow(fa)];
        this.sourceComboboxValue = '';
    }

    handleDestSearchTermChange(event) {
        this.destSearchTerm = event.detail.value;
        window.clearTimeout(this._destSearchTimeout);
        this._destSearchTimeout = window.setTimeout(() => this._runDestSearch(), 300);
    }

    handleSelectDestSearchResult(event) {
        const id = event.currentTarget.dataset.id;
        const fa = this._destSearchRawResults.find((r) => r.id === id);
        if (!fa) return;
        this.destinationSelected = [...this.destinationSelected, this._makeRow(fa)];
        this.destSearchTerm = '';
        this._destSearchRawResults = [];
    }

    _runDestSearch() {
        const term = this.destSearchTerm?.trim();
        if (!term || term.length < 4) {
            this._destSearchRawResults = [];
            return;
        }

        this.isSearchingDest = true;
        searchFinancialAccounts({ searchTerm: term })
            .then((results) => {
                this._destSearchRawResults = results;
            })
            .catch((e) => {
                this.error = this._extractError(e);
            })
            .finally(() => {
                this.isSearchingDest = false;
            });
    }

    handleAmountChange(event) {
        const key = Number(event.target.dataset.key);
        const side = event.target.dataset.side;
        const value = event.detail.value;
        if (side === 'source') {
            this.sourceSelected = this.sourceSelected.map((r) =>
                r._key === key ? { ...r, amount: value } : r
            );
        } else {
            this.destinationSelected = this.destinationSelected.map((r) =>
                r._key === key ? { ...r, amount: value } : r
            );
        }
    }

    handleRemoveAccount(event) {
        const key = Number(event.target.dataset.key);
        const side = event.target.dataset.side;
        if (side === 'source') {
            this.sourceSelected = this.sourceSelected.filter((r) => r._key !== key);
        } else {
            this.destinationSelected = this.destinationSelected.filter((r) => r._key !== key);
        }
        // availableOptions is derived, so the account automatically reappears in both dropdowns
    }

    handleTransferDateChange(event) {
        this.transferDate = event.detail.value;
    }

    handleSaveDraft() {
        this._save('Draft');
    }

    handleSubmit() {
        this._save('Submitted');
    }

    handleCancel() {
        this._resetForm();
        this.isFormMode = false;
    }

    // --- Private ---

    _makeRow(fa) {
        return {
            _key: ++this._keyCounter,
            id: fa.id,
            name: fa.name,
            lastFour: fa.financialAccountNumber?.slice(-4) ?? '????',
            balance: fa.balance,
            amount: null
        };
    }

    _formatAccountLabel(fa) {
        const bal =
            fa.balance != null
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(fa.balance)
                : 'No balance';
        return `${fa.name} — ${bal}`;
    }

    _inferTransferType() {
        const s = this.sourceSelected.length;
        const d = this.destinationSelected.length;
        if (s === 1 && d === 1) return '1:1';
        if (s === 1) return '1:N';
        if (d === 1) return 'N:1';
        return 'N:N';
    }

    _resetForm() {
        this.sourceSelected = [];
        this.destinationSelected = [];
        this.transferDate = null;
        this.sourceComboboxValue = '';
        this.destSearchTerm = '';
        this._destSearchRawResults = [];
        this.error = null;
    }

    async _save(status) {
        const isSubmit = status === 'Submitted';
        if (!this._validate(isSubmit)) return;

        if (this.objectApiName !== 'Case') {
            this.error = 'Transfers can only be saved from a Case record.';
            return;
        }

        this.isLoading = true;
        try {
            await saveTransferRequests({
                payloadJson: JSON.stringify({
                    caseId: this.recordId,
                    transferType: this._inferTransferType(),
                    startDate: this.transferDate,
                    status,
                    sourceRows: this.sourceSelected.map((r) => ({
                        financialAccountId: r.id,
                        amount: this._effectiveSourceAmount(r)
                    })),
                    destinationRows: this.destinationSelected.map((r) => ({
                        financialAccountId: r.id,
                        amount: this._effectiveDestinationAmount(r)
                    }))
                })
            });

            this.dispatchEvent(
                new ShowToastEvent({
                    title: 'Success',
                    message: isSubmit ? 'Transfer submitted successfully.' : 'Draft saved successfully.',
                    variant: 'success'
                })
            );
            this._resetForm();
            this.isFormMode = false;
            await refreshApex(this.wiredSummary);
        } catch (e) {
            this.error = this._extractError(e);
        } finally {
            this.isLoading = false;
        }
    }

    _parseAmount(value) {
        const n = parseFloat(String(value ?? '').replace(/[^0-9.]/g, ''));
        return isFinite(n) ? n : 0;
    }

    // The non-editable side has exactly one row, whose amount is the matching total.
    _effectiveSourceAmount(row) {
        return this.sourceAmountEditable ? this._parseAmount(row.amount) : this.sourceTotal;
    }

    _effectiveDestinationAmount(row) {
        return this.destinationAmountEditable ? this._parseAmount(row.amount) : this.destinationTotal;
    }

    _extractError(e) {
        console.error('TransferConfiguration error:', JSON.stringify(e));
        const dmlErrors = e?.body?.output?.errors;
        if (dmlErrors?.length) {
            return dmlErrors.map((err) => err.message).join(' ');
        }
        const fieldErrors = e?.body?.output?.fieldErrors;
        if (fieldErrors) {
            return Object.values(fieldErrors)
                .flat()
                .map((err) => err.message)
                .join(' ');
        }
        return e?.body?.message ?? e?.message ?? 'An unexpected error occurred.';
    }

    _validate(isSubmit) {
        if (!this.transferDate) {
            this.error = 'Transfer date is required.';
            return false;
        }

        if (this.sourceSelected.length === 0) {
            this.error = 'At least one source account is required.';
            return false;
        }

        if (this.destinationSelected.length === 0) {
            this.error = 'At least one destination account is required.';
            return false;
        }

        const sourceIncomplete = this.sourceAmountEditable
            ? this.sourceSelected.some((r) => this._parseAmount(r.amount) <= 0)
            : this.sourceTotal <= 0;
        const destinationIncomplete = this.destinationAmountEditable
            ? this.destinationSelected.some((r) => this._parseAmount(r.amount) <= 0)
            : this.destinationTotal <= 0;
        if (sourceIncomplete || destinationIncomplete) {
            this.error = 'All amount fields must be greater than zero.';
            return false;
        }

        if (isSubmit) {
            for (const row of this.sourceSelected) {
                const requested = this._effectiveSourceAmount(row);
                if (row.balance != null && requested > row.balance) {
                    const fmt = (n) =>
                        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
                    this.error = `Account ****${row.lastFour} has ${fmt(row.balance)} available but ${fmt(requested)} requested.`;
                    return false;
                }
            }
            if (this.hasTotalMismatch) {
                this.error = 'Source and destination totals must match before submitting.';
                return false;
            }
        }

        this.error = null;
        return true;
    }
}
