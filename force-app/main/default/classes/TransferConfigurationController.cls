public with sharing class TransferConfigurationController {

    // ── Object switch ──────────────────────────────────────────────────────────
    // false → Fund_Transfer_Request__c (custom object, current dev org)
    // true  → FundTransferRequest       (standard FSC object, target org)
    // Flip this one constant and redeploy — nothing else needs to change.
    private static final Boolean USE_STANDARD_OBJECT = false;

    private static final String OBJ    = USE_STANDARD_OBJECT ? 'FundTransferRequest'  : 'Fund_Transfer_Request__c';
    private static final String F_CASE = USE_STANDARD_OBJECT ? 'CaseId'               : 'Case__c';
    private static final String F_FROM = USE_STANDARD_OBJECT ? 'FromId'               : 'From_Account__c';
    private static final String F_TO   = USE_STANDARD_OBJECT ? 'ToId'                 : 'To_Account__c';
    private static final String F_AMT  = USE_STANDARD_OBJECT ? 'Amount'               : 'Amount__c';
    private static final String F_DATE = USE_STANDARD_OBJECT ? 'StartDate'            : 'Start_Date__c';
    private static final String F_STAT = USE_STANDARD_OBJECT ? 'Status'               : 'Status__c';
    private static final String F_TYPE = USE_STANDARD_OBJECT ? 'TransferType'         : 'Transfer_Type__c';

    // ── Inner classes ──────────────────────────────────────────────────────────

    public class FinancialAccountInfo {
        @AuraEnabled public Id     id;
        @AuraEnabled public String name;
        @AuraEnabled public String type;
        @AuraEnabled public String financialAccountNumber;
        @AuraEnabled public String status;
        @AuraEnabled public Decimal balance;
    }

    // One row in the save payload — always a 1:1 transfer.
    public class TransferRow {
        public String  fromId;
        public String  toId;
        public Decimal amount;
    }

    // One row in the read-side summary — mirrors the saved record 1:1.
    public class TransferSummaryRow {
        @AuraEnabled public Id     sourceId;
        @AuraEnabled public String sourceName;
        @AuraEnabled public String sourceNumber;
        @AuraEnabled public Id     destId;
        @AuraEnabled public String destName;
        @AuraEnabled public String destNumber;
        @AuraEnabled public Decimal amount;
    }

    public class TransferSummary {
        @AuraEnabled public Date   transferDate;
        @AuraEnabled public String status;
        @AuraEnabled public List<TransferSummaryRow> rows;
    }

    public class SavePayload {
        public String caseId;
        public String startDate;
        public String status;
        public List<TransferRow> rows;
    }

    // ── getFinancialAccounts ───────────────────────────────────────────────────

    @AuraEnabled(cacheable=true)
    public static List<FinancialAccountInfo> getFinancialAccounts(Id accountId) {
        if (accountId == null) {
            return new List<FinancialAccountInfo>();
        }

        List<FinancialAccountParty> parties = [
            SELECT FinancialAccountId,
                   FinancialAccount.Name,
                   FinancialAccount.Type,
                   FinancialAccount.FinancialAccountNumber,
                   FinancialAccount.Status
            FROM FinancialAccountParty
            WHERE AccountId = :accountId
              AND Role = 'Owner'
              AND FinancialAccount.Status = 'Active'
            ORDER BY FinancialAccount.Name ASC
            LIMIT 200
        ];

        Set<Id> financialAccountIds = new Set<Id>();
        for (FinancialAccountParty party : parties) {
            financialAccountIds.add(party.FinancialAccountId);
        }

        Map<Id, Decimal> balanceByAccountId = new Map<Id, Decimal>();
        for (FinancialAccountBalance bal : [
            SELECT FinancialAccountId, Amount
            FROM FinancialAccountBalance
            WHERE FinancialAccountId IN :financialAccountIds
            ORDER BY BalanceAsOfDate DESC, CreatedDate DESC
        ]) {
            if (!balanceByAccountId.containsKey(bal.FinancialAccountId)) {
                balanceByAccountId.put(bal.FinancialAccountId, bal.Amount);
            }
        }

        List<FinancialAccountInfo> result = new List<FinancialAccountInfo>();
        for (FinancialAccountParty party : parties) {
            FinancialAccountInfo info = new FinancialAccountInfo();
            info.id                   = party.FinancialAccountId;
            info.name                 = party.FinancialAccount.Name;
            info.type                 = party.FinancialAccount.Type;
            info.financialAccountNumber = party.FinancialAccount.FinancialAccountNumber;
            info.status               = party.FinancialAccount.Status;
            info.balance              = balanceByAccountId.get(party.FinancialAccountId);
            result.add(info);
        }
        return result;
    }

    // ── searchFinancialAccounts ────────────────────────────────────────────────
    // Ad-hoc lookup for destination accounts that the customer doesn't own
    // (e.g. paying a third party). Requires a minimum search length and caps
    // results so we never expose a browsable list of other customers' accounts.

    // Set to true to block saves when a source account's requested amount exceeds
    // its latest known balance. Leave false when balance enforcement is handled
    // downstream (e.g. by the actual transfer execution process).
    private static final Boolean ENFORCE_BALANCE_CHECK = false;

    private static final Integer SEARCH_MIN_LENGTH   = 4;
    private static final Integer SEARCH_RESULT_LIMIT = 20;

    @AuraEnabled(cacheable=true)
    public static List<FinancialAccountInfo> searchFinancialAccounts(String searchTerm) {
        String term = searchTerm == null ? '' : searchTerm.trim();
        if (term.length() < SEARCH_MIN_LENGTH) {
            return new List<FinancialAccountInfo>();
        }

        String likeTerm = '%' + String.escapeSingleQuotes(term) + '%';
        List<FinancialAccount> accounts = [
            SELECT Id, Name, Type, FinancialAccountNumber, Status
            FROM FinancialAccount
            WHERE Status = 'Active'
              AND (Name LIKE :likeTerm OR FinancialAccountNumber LIKE :likeTerm)
            ORDER BY Name ASC
            LIMIT :SEARCH_RESULT_LIMIT
        ];

        // Balance is intentionally omitted — these may not be the customer's own accounts.
        List<FinancialAccountInfo> result = new List<FinancialAccountInfo>();
        for (FinancialAccount fa : accounts) {
            FinancialAccountInfo info = new FinancialAccountInfo();
            info.id                   = fa.Id;
            info.name                 = fa.Name;
            info.type                 = fa.Type;
            info.financialAccountNumber = fa.FinancialAccountNumber;
            info.status               = fa.Status;
            result.add(info);
        }
        return result;
    }

    // ── getTransferSummary ─────────────────────────────────────────────────────

    @AuraEnabled(cacheable=true)
    public static TransferSummary getTransferSummary(Id caseId) {
        if (caseId == null) return null;

        String soql =
            'SELECT Id, ' + F_FROM + ', ' + F_TO + ', ' + F_AMT + ', ' +
                            F_DATE  + ', ' + F_STAT +
            ' FROM '  + OBJ +
            ' WHERE ' + F_CASE + ' = :caseId' +
            ' ORDER BY CreatedDate ASC';
        List<SObject> records = Database.query(soql);

        if (records.isEmpty()) return null;

        Set<Id> faIds = new Set<Id>();
        for (SObject r : records) {
            Id fromId = (Id) r.get(F_FROM);
            Id toId   = (Id) r.get(F_TO);
            if (fromId != null) faIds.add(fromId);
            if (toId   != null) faIds.add(toId);
        }

        Map<Id, FinancialAccount> faMap = new Map<Id, FinancialAccount>([
            SELECT Id, Name, FinancialAccountNumber
            FROM FinancialAccount
            WHERE Id IN :faIds
        ]);

        List<TransferSummaryRow> rows = new List<TransferSummaryRow>();
        for (SObject r : records) {
            Id      fromId = (Id)      r.get(F_FROM);
            Id      toId   = (Id)      r.get(F_TO);
            Decimal amount = (Decimal) r.get(F_AMT);

            FinancialAccount src = faMap.get(fromId);
            FinancialAccount dst = faMap.get(toId);

            TransferSummaryRow row = new TransferSummaryRow();
            row.sourceId     = fromId;
            row.sourceName   = src?.Name;
            row.sourceNumber = src?.FinancialAccountNumber;
            row.destId       = toId;
            row.destName     = dst?.Name;
            row.destNumber   = dst?.FinancialAccountNumber;
            row.amount       = amount;
            rows.add(row);
        }

        TransferSummary summary = new TransferSummary();
        summary.transferDate = (Date)   records[0].get(F_DATE);
        summary.status       = (String) records[0].get(F_STAT);
        summary.rows         = rows;
        return summary;
    }

    // ── saveTransferRequests ───────────────────────────────────────────────────

    @AuraEnabled
    public static void saveTransferRequests(String payloadJson) {
        if (String.isBlank(payloadJson)) {
            throw new AuraHandledException('payloadJson is required.');
        }

        SavePayload p = (SavePayload) JSON.deserialize(payloadJson, SavePayload.class);
        Id   caseId    = (Id)   p.caseId;
        Date startDate = Date.valueOf(p.startDate);
        Schema.SObjectType objType = Schema.getGlobalDescribe().get(OBJ);

        // Replace any existing records for this case so edit+save is always a clean set.
        String delSoql = 'SELECT Id FROM ' + OBJ + ' WHERE ' + F_CASE + ' = :caseId';
        List<SObject> existing = Database.query(delSoql);
        if (!existing.isEmpty()) delete existing;

        if (ENFORCE_BALANCE_CHECK) {
            Set<Id> sourceIds = new Set<Id>();
            for (TransferRow row : p.rows) sourceIds.add((Id) row.fromId);

            Map<Id, Decimal> latestBalance = new Map<Id, Decimal>();
            for (FinancialAccountBalance bal : [
                SELECT FinancialAccountId, Amount
                FROM FinancialAccountBalance
                WHERE FinancialAccountId IN :sourceIds
                ORDER BY BalanceAsOfDate DESC, CreatedDate DESC
            ]) {
                if (!latestBalance.containsKey(bal.FinancialAccountId)) {
                    latestBalance.put(bal.FinancialAccountId, bal.Amount);
                }
            }

            for (TransferRow row : p.rows) {
                Id      srcId   = (Id) row.fromId;
                Decimal balance = latestBalance.get(srcId);
                if (balance != null && row.amount > balance) {
                    throw new AuraHandledException(
                        'Insufficient balance on account ' + srcId +
                        ': requested ' + row.amount + ', available ' + balance + '.'
                    );
                }
            }
        }

        List<SObject> records = new List<SObject>();
        for (TransferRow row : p.rows) {
            records.add(buildRecord(objType, caseId, (Id) row.fromId, (Id) row.toId,
                        row.amount, startDate, p.status, '1:1'));
        }
        insert records;
    }

    private static SObject buildRecord(
        Schema.SObjectType objType,
        Id caseId, Id fromId, Id toId, Decimal amount,
        Date startDate, String status, String transferType
    ) {
        SObject rec = objType.newSObject();
        rec.put(F_CASE, caseId);
        rec.put(F_FROM, fromId);
        rec.put(F_TO,   toId);
        rec.put(F_AMT,  amount);
        rec.put(F_DATE, startDate);
        rec.put(F_STAT, status);
        rec.put(F_TYPE, transferType);
        return rec;
    }

    // ── deleteTransferRequests ─────────────────────────────────────────────────

    @AuraEnabled
    public static void deleteTransferRequests(Id caseId) {
        String soql = 'SELECT Id FROM ' + OBJ + ' WHERE ' + F_CASE + ' = :caseId';
        delete Database.query(soql);
    }
}
