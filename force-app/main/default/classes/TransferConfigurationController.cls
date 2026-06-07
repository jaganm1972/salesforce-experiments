public with sharing class TransferConfigurationController {

    // ── Object switch ──────────────────────────────────────────────────────────
    // false → Fund_Transfer_Request__c (custom object, current dev org)
    // true  → FundTransferRequest       (standard FSC object, target org)
    // Flip this one constant and redeploy — nothing else needs to change.
    private static final Boolean USE_STANDARD_OBJECT = false;

    private static final String OBJ     = USE_STANDARD_OBJECT ? 'FundTransferRequest'  : 'Fund_Transfer_Request__c';
    private static final String F_CASE  = USE_STANDARD_OBJECT ? 'CaseId'               : 'Case__c';
    private static final String F_FROM  = USE_STANDARD_OBJECT ? 'FromId'               : 'From_Account__c';
    private static final String F_TO    = USE_STANDARD_OBJECT ? 'ToId'                 : 'To_Account__c';
    private static final String F_AMT   = USE_STANDARD_OBJECT ? 'Amount'               : 'Amount__c';
    private static final String F_DATE  = USE_STANDARD_OBJECT ? 'StartDate'            : 'Start_Date__c';
    private static final String F_STAT  = USE_STANDARD_OBJECT ? 'Status'               : 'Status__c';
    private static final String F_TYPE  = USE_STANDARD_OBJECT ? 'TransferType'         : 'Transfer_Type__c';

    // ── Inner classes ──────────────────────────────────────────────────────────

    public class FinancialAccountInfo {
        @AuraEnabled public Id id;
        @AuraEnabled public String name;
        @AuraEnabled public String type;
        @AuraEnabled public String financialAccountNumber;
        @AuraEnabled public String status;
        @AuraEnabled public Decimal balance;
    }

    public class TransferRow {
        @AuraEnabled public Id financialAccountId;
        @AuraEnabled public Decimal amount;
    }

    public class TransferLineInfo {
        @AuraEnabled public Id recordId;
        @AuraEnabled public String accountName;
        @AuraEnabled public String accountNumber;
        @AuraEnabled public String accountType;
        @AuraEnabled public Decimal amount;
    }

    public class TransferSummary {
        @AuraEnabled public Date transferDate;
        @AuraEnabled public String status;
        @AuraEnabled public String transferType;
        @AuraEnabled public List<TransferLineInfo> sources;
        @AuraEnabled public List<TransferLineInfo> destinations;
    }

    public class SavePayload {
        public String caseId;
        public String transferType; // drives routing logic; also written to the record
        public String startDate;
        public String status;
        public List<TransferRow> sourceRows;
        public List<TransferRow> destinationRows;
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
            info.id = party.FinancialAccountId;
            info.name = party.FinancialAccount.Name;
            info.type = party.FinancialAccount.Type;
            info.financialAccountNumber = party.FinancialAccount.FinancialAccountNumber;
            info.status = party.FinancialAccount.Status;
            info.balance = balanceByAccountId.get(party.FinancialAccountId);
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
                            F_DATE  + ', ' + F_STAT + ', ' + F_TYPE +
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
            SELECT Id, Name, FinancialAccountNumber, Type
            FROM FinancialAccount
            WHERE Id IN :faIds
        ]);

        Map<Id, TransferLineInfo> sourceMap = new Map<Id, TransferLineInfo>();
        Map<Id, TransferLineInfo> destMap   = new Map<Id, TransferLineInfo>();

        for (SObject r : records) {
            Id      fromId = (Id)      r.get(F_FROM);
            Id      toId   = (Id)      r.get(F_TO);
            Decimal amount = (Decimal) r.get(F_AMT);

            if (fromId != null) {
                if (!sourceMap.containsKey(fromId)) {
                    FinancialAccount fa = faMap.get(fromId);
                    TransferLineInfo line = new TransferLineInfo();
                    line.recordId    = fromId;
                    line.accountName = fa?.Name;
                    line.accountNumber = fa?.FinancialAccountNumber;
                    line.accountType = fa?.Type;
                    line.amount = 0;
                    sourceMap.put(fromId, line);
                }
                sourceMap.get(fromId).amount += amount;
            }

            if (toId != null) {
                if (!destMap.containsKey(toId)) {
                    FinancialAccount fa = faMap.get(toId);
                    TransferLineInfo line = new TransferLineInfo();
                    line.recordId    = toId;
                    line.accountName = fa?.Name;
                    line.accountNumber = fa?.FinancialAccountNumber;
                    line.accountType = fa?.Type;
                    line.amount = 0;
                    destMap.put(toId, line);
                }
                destMap.get(toId).amount += amount;
            }
        }

        TransferSummary summary = new TransferSummary();
        summary.transferDate = (Date)   records[0].get(F_DATE);
        summary.status       = (String) records[0].get(F_STAT);
        summary.transferType = (String) records[0].get(F_TYPE);
        summary.sources      = sourceMap.values();
        summary.destinations = destMap.values();
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

        List<SObject> records = new List<SObject>();

        if (p.transferType == '1:1') {
            records.add(buildRecord(objType, caseId, p.sourceRows[0].financialAccountId,
                        p.destinationRows[0].financialAccountId, p.sourceRows[0].amount,
                        startDate, p.status, p.transferType));

        } else if (p.transferType == '1:N') {
            for (TransferRow dest : p.destinationRows) {
                records.add(buildRecord(objType, caseId, p.sourceRows[0].financialAccountId,
                            dest.financialAccountId, dest.amount,
                            startDate, p.status, p.transferType));
            }

        } else if (p.transferType == 'N:1') {
            for (TransferRow src : p.sourceRows) {
                records.add(buildRecord(objType, caseId, src.financialAccountId,
                            p.destinationRows[0].financialAccountId, src.amount,
                            startDate, p.status, p.transferType));
            }

        } else {
            // N:N waterfall: walk two pointers through sources and destinations,
            // pairing min(remaining source, remaining destination) at each step.
            // Produces at most M+N-1 records; totals on both sides are preserved exactly.
            List<Decimal> srcRem = new List<Decimal>();
            List<Decimal> dstRem = new List<Decimal>();
            for (TransferRow r : p.sourceRows) srcRem.add(r.amount);
            for (TransferRow r : p.destinationRows) dstRem.add(r.amount);

            Integer si = 0, di = 0;
            while (si < p.sourceRows.size() && di < p.destinationRows.size()) {
                Decimal pairAmt = srcRem[si] <= dstRem[di] ? srcRem[si] : dstRem[di];
                records.add(buildRecord(objType, caseId,
                            p.sourceRows[si].financialAccountId,
                            p.destinationRows[di].financialAccountId,
                            pairAmt, startDate, p.status, p.transferType));
                srcRem[si] -= pairAmt;
                dstRem[di] -= pairAmt;
                if (srcRem[si] == 0) si++;
                if (dstRem[di] == 0) di++;
            }
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
