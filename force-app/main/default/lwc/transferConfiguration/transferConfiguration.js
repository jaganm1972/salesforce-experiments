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
const OTHER_VALUE = '__other__';

export default class TransferConfiguration extends LightningElement {
    @api recordId;
    @api objectApiName;

    @track isFormMode = false;
    @track transferRows = [];
    @track transferDate;
    @track isLoading = false;
    @track error;

    _keyCounter = 0;
    _searchTimeouts = {};

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

    get financialAccounts() {
        return this.wiredFinancialAccounts?.data ?? [];
    }

    get summary() {
        const raw = this.wiredSummary?.data;
        if (!raw) return null;
        return {
            ...raw,
            rows: raw.rows.map((r, i) => ({
                ...r,
                rowKey: i,
                sourceLastFour: r.sourceNumber?.slice(-4) ?? '????',
                destLastFour:   r.destNumber?.slice(-4)   ?? '????'
            }))
        };
    }

    get hasTransferSummary() {
        return this.summary != null;
    }

    get hasTransferRows() {
        return this.transferRows.length > 0;
    }

    // Builds per-row display objects with computed option lists and search results.
    // Per-row constraints:
    //   - Source dropdown excludes the row's own selected destination (owned accounts only).
    //   - Destination dropdown excludes the row's own selected source.
    //   - "Other" search results additionally exclude external accounts already locked
    //     in as the destination in any other row, preventing duplicate external targets.
    get displayRows() {
        const allAccounts = this.financialAccounts;

        const lockedExternalIds = new Set(
            this.transferRows
                .filter(r => r.destIsExternal && r.destAccountId)
                .map(r => r.destAccountId)
        );

        return this.transferRows.map(row => {
            const sourceOptions = allAccounts
                .filter(fa => fa.id !== row.destAccountId)
                .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))
                .map(fa => ({ label: this._formatAccountLabel(fa), value: fa.id }));

            const destOptions = [
                ...allAccounts
                    .filter(fa => fa.id !== row.sourceAccountId)
                    .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))
                    .map(fa => ({ label: this._formatAccountLabel(fa), value: fa.id })),
                { label: 'Other — search by account name or number', value: OTHER_VALUE }
            ];

            const destSearchResults = row._destSearchRawResults
                .filter(fa => {
                    if (fa.id === row.sourceAccountId) return false;
                    if (lockedExternalIds.has(fa.id)) return false;
                    return true;
                })
                .map(fa => ({
                    id: fa.id,
                    displayLabel: `${fa.name} • ****${fa.financialAccountNumber?.slice(-4) ?? '????'}`
                }));

            // showDestCombo: show the dropdown unless an external account is locked in
            const showDestCombo = !(row.destIsExternal && row.destAccountId);
            const showDestSearch = row.destIsExternal && !row.destAccountId;
            const showDestExternalChip = row.destIsExternal && !!row.destAccountId;
            const destComboValue = row.destIsExternal ? OTHER_VALUE : (row.destAccountId ?? '');

            return {
                ...row,
                sourceOptions,
                destOptions,
                destSearchResults,
                hasDestSearchResults: destSearchResults.length > 0,
                showDestCombo,
                showDestSearch,
                showDestExternalChip,
                destComboValue
            };
        });
    }

    // --- List mode handlers ---

    handleNew() {
        this.isFormMode = true;
    }

    handleEdit() {
        if (this.summary) {
            this.transferDate = this.summary.transferDate;
            this.transferRows = this.summary.rows.map(r => {
                const isOwned = this.financialAccounts.some(fa => fa.id === r.destId);
                return {
                    _key: ++this._keyCounter,
                    sourceAccountId:     r.sourceId,
                    destAccountId:       r.destId,
                    destIsExternal:      !isOwned,
                    destExternalName:    !isOwned ? r.destName   : null,
                    destExternalLastFour:!isOwned ? r.destNumber?.slice(-4) ?? '????' : null,
                    amount:              r.amount,
                    destSearchTerm:      '',
                    _destSearchRawResults: []
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

    // --- Form mode handlers ---

    handleAddRow() {
        this.transferRows = [...this.transferRows, {
            _key:                 ++this._keyCounter,
            sourceAccountId:      null,
            destAccountId:        null,
            destIsExternal:       false,
            destExternalName:     null,
            destExternalLastFour: null,
            amount:               null,
            destSearchTerm:       '',
            _destSearchRawResults: []
        }];
    }

    handleRemoveRow(event) {
        const key = Number(event.currentTarget.dataset.key);
        this.transferRows = this.transferRows.filter(r => r._key !== key);
    }

    handleSourceChange(event) {
        const key = Number(event.target.dataset.key);
        this._updateRow(key, { sourceAccountId: event.detail.value || null });
    }

    handleDestChange(event) {
        const key = Number(event.target.dataset.key);
        const value = event.detail.value;
        if (value === OTHER_VALUE) {
            this._updateRow(key, {
                destIsExternal:        true,
                destAccountId:         null,
                destExternalName:      null,
                destExternalLastFour:  null,
                destSearchTerm:        '',
                _destSearchRawResults: []
            });
        } else {
            this._updateRow(key, {
                destAccountId:         value || null,
                destIsExternal:        false,
                destExternalName:      null,
                destExternalLastFour:  null,
                destSearchTerm:        '',
                _destSearchRawResults: []
            });
        }
    }

    handleClearExternalDest(event) {
        const key = Number(event.currentTarget.dataset.key);
        this._updateRow(key, {
            destIsExternal:        false,
            destAccountId:         null,
            destExternalName:      null,
            destExternalLastFour:  null,
            destSearchTerm:        '',
            _destSearchRawResults: []
        });
    }

    handleDestSearchTermChange(event) {
        const key = Number(event.target.dataset.key);
        const term = event.detail.value;
        this._updateRow(key, { destSearchTerm: term });
        window.clearTimeout(this._searchTimeouts[key]);
        this._searchTimeouts[key] = window.setTimeout(() => this._runDestSearch(key, term), 300);
    }

    handleSelectDestSearchResult(event) {
        const key = Number(event.currentTarget.dataset.key);
        const id  = event.currentTarget.dataset.id;
        const row = this.transferRows.find(r => r._key === key);
        if (!row) return;
        const fa = row._destSearchRawResults.find(r => r.id === id);
        if (!fa) return;
        this._updateRow(key, {
            destAccountId:         fa.id,
            destIsExternal:        true,
            destExternalName:      fa.name,
            destExternalLastFour:  fa.financialAccountNumber?.slice(-4) ?? '????',
            destSearchTerm:        '',
            _destSearchRawResults: []
        });
    }

    handleAmountChange(event) {
        const key = Number(event.target.dataset.key);
        this._updateRow(key, { amount: event.detail.value });
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

    _updateRow(key, updates) {
        this.transferRows = this.transferRows.map(r =>
            r._key === key ? { ...r, ...updates } : r
        );
    }

    _runDestSearch(key, term) {
        const trimmed = term?.trim();
        if (!trimmed || trimmed.length < 4) {
            this._updateRow(key, { _destSearchRawResults: [] });
            return;
        }
        searchFinancialAccounts({ searchTerm: trimmed })
            .then(results => {
                // Guard against a stale response arriving after the user changed the term.
                const row = this.transferRows.find(r => r._key === key);
                if (row && row.destSearchTerm === term) {
                    this._updateRow(key, { _destSearchRawResults: results });
                }
            })
            .catch(e => { this.error = this._extractError(e); });
    }

    _formatAccountLabel(fa) {
        const bal = fa.balance != null
            ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(fa.balance)
            : 'No balance';
        return `${fa.name} — ${bal}`;
    }

    _resetForm() {
        this.transferRows = [];
        this.transferDate = null;
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
                    caseId:    this.recordId,
                    startDate: this.transferDate,
                    status,
                    rows: this.transferRows.map(r => ({
                        fromId: r.sourceAccountId,
                        toId:   r.destAccountId,
                        amount: this._parseAmount(r.amount)
                    }))
                })
            });
            this.dispatchEvent(new ShowToastEvent({
                title:   'Success',
                message: isSubmit ? 'Transfer submitted successfully.' : 'Draft saved successfully.',
                variant: 'success'
            }));
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

    _extractError(e) {
        console.error('TransferConfiguration error:', JSON.stringify(e));
        const dmlErrors = e?.body?.output?.errors;
        if (dmlErrors?.length) return dmlErrors.map(err => err.message).join(' ');
        const fieldErrors = e?.body?.output?.fieldErrors;
        if (fieldErrors) return Object.values(fieldErrors).flat().map(err => err.message).join(' ');
        return e?.body?.message ?? e?.message ?? 'An unexpected error occurred.';
    }

    _validate(isSubmit) {
        if (!this.transferDate) {
            this.error = 'Transfer date is required.';
            return false;
        }
        if (this.transferRows.length === 0) {
            this.error = 'At least one transfer row is required.';
            return false;
        }
        for (const row of this.transferRows) {
            if (!row.sourceAccountId) {
                this.error = 'All rows must have a source account selected.';
                return false;
            }
            if (!row.destAccountId) {
                this.error = 'All rows must have a destination account selected.';
                return false;
            }
            if (row.sourceAccountId === row.destAccountId) {
                this.error = 'Source and destination cannot be the same account.';
                return false;
            }
            if (this._parseAmount(row.amount) <= 0) {
                this.error = 'All rows must have an amount greater than zero.';
                return false;
            }
        }
        this.error = null;
        return true;
    }
}
