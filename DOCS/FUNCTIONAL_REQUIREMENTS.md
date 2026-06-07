# Functional Requirements: Multi-Account Transfer System
**Salesforce Case-Based Transfer Management for HNW Customers**

**Document Version:** 2.0
**Date:** June 7, 2026
**Status:** Updated to reflect implemented solution

---

## 1. EXECUTIVE SUMMARY

This document outlines the functional requirements for a **Multi-Account Transfer System** integrated into Salesforce. The system enables bank tellers to capture and manage transfer instructions for high-net-worth (HNW) customers across multiple account combinations (1:1, 1:N, N:1, N:N). The system validates balances and stores transfer configurations in Salesforce for further processing.

---

## 2. BUSINESS CONTEXT & MOTIVATION

### 2.1 User Base
- **Primary Users:** Bank tellers/employees
- **On behalf of:** HNW customers with varied business interests and multiple accounts
- **Target Customers:** Those requiring complex transfer arrangements across multiple accounts

### 2.2 Key Use Cases
| Scenario | Description | Example |
|----------|-------------|---------|
| **1:1 Transfer** | Single source → single destination | Transfer $50K from checking to savings |
| **1:N Transfer** | Single source → multiple destinations | Split investment proceeds to 3 accounts |
| **N:1 Transfer** | Multiple sources → single destination | Consolidate 5 accounts into one |
| **N:N Transfer** | Multiple sources → multiple destinations | Distribute across complex account structure |

### 2.3 Relationship to Salesforce Case
- The component can be embedded on either an **Account** page (account ID read directly from the record) or a **Case** page (account ID resolved from `Case.AccountId`)
- The transfer configuration is captured and displayed within the case
- Saving transfers is only permitted from a Case page context (the `CaseId` foreign key requires it)
- **Out of Scope:** Actual transfer execution (handled separately by backend systems)

---

## 3. FUNCTIONAL REQUIREMENTS

### 3.1 Transfer Type (F1)
**Requirement:** The system shall determine the transfer type automatically from the number of source and destination accounts selected.

**Details:**
- Transfer type is **inferred at save time** — no manual selection required
- Inference rules:

| Sources | Destinations | Inferred Type |
|---------|-------------|---------------|
| 1 | 1 | `1:1` |
| 1 | > 1 | `1:N` |
| > 1 | 1 | `N:1` |
| > 1 | > 1 | `N:N` |

- The inferred type is stored on the transfer record(s) and displayed in the list view

**Priority:** P0 (Core)

---

### 3.2 Account Selection (F2)
**Requirement:** Users shall select source and destination accounts from a shared available pool that updates dynamically as accounts are chosen.

**Details:**
- Account list sourced via **`FinancialAccountParty`** (junction object linking `Account` to `FinancialAccount`); only records where `Role = 'Owner'` and `FinancialAccount.Status = 'Active'` are returned
- Both source and destination dropdowns draw from the **same available pool**, sorted by balance descending
- Dropdown label format: `Account Name — $X,XXX` (balance rounded to nearest dollar)
- When an account is selected in either column, it is **removed from both dropdowns** immediately — structural prevention of source/destination overlap and within-column duplicates
- When the trash icon removes an account from a column, it **returns to both dropdowns** automatically
- No upper limit on the number of accounts per column
- Accounts must belong to the customer context of the parent case

**Priority:** P0 (Core)

---

### 3.3 Amount Input (F3)
**Requirement:** Each selected account row shall display the account details and accept an individual transfer amount.

**Details:**
- Each selected account row shows:
  - Account name
  - Last 4 digits of account number (masked as `****XXXX`)
  - Current balance (from most recent `FinancialAccountBalance` record)
  - Currency amount input field
  - Trash icon to deselect the account
- Running totals are shown at the bottom of each column once at least one account is selected
- A mismatch warning is displayed inline when both columns have amounts entered but the totals differ
- Source total must equal destination total before submission is allowed

**Priority:** P0 (Core)

---

### 3.4 Balance Validation (F4)
**Requirement:** System shall validate that source accounts have sufficient balance before a transfer is submitted.

**Details:**
- Validation is triggered on **Submit** only (not on Draft save)
- Check per source account: entered amount ≤ available balance for that account
- If insufficient balance:
  - Inline error message identifies the account (by last 4 digits) and states the shortfall
  - Form submission is blocked
- Balance data retrieved from the most recent `FinancialAccountBalance` record per account, ordered by `BalanceAsOfDate DESC, CreatedDate DESC`
- Accounts with no `FinancialAccountBalance` record still allow amount entry; balance check is skipped for those accounts

**Priority:** P0 (Core)

---

### 3.5 Transfer Configuration Persistence (F5)
**Requirement:** System shall save transfer configurations using a configurable storage object, switchable between a custom development object and the standard FSC object.

**Details:**

#### 3.5.1 Dual-Object Architecture
A single boolean constant in `TransferConfigurationController.cls` controls which object is used:

```apex
private static final Boolean USE_STANDARD_OBJECT = false;
```

| Value | Object Used | Context |
|-------|-------------|---------|
| `false` | `Fund_Transfer_Request__c` (custom) | Development / current org |
| `true` | `FundTransferRequest` (standard FSC) | Target / production org |

Flipping the constant and redeploying the Apex class is the only change required to switch.

#### 3.5.2 Custom Object: `Fund_Transfer_Request__c`
| Field | API Name | Type | Notes |
|-------|----------|------|-------|
| Request Number | `Name` | Auto Number | Format: `FTR-{0000}` |
| Case | `Case__c` | Lookup (Case) | Parent case |
| From Account | `From_Account__c` | Lookup (FinancialAccount) | Source account |
| To Account | `To_Account__c` | Lookup (FinancialAccount) | Destination account |
| Amount | `Amount__c` | Currency (18,2) | Amount for this FROM→TO pair |
| Start Date | `Start_Date__c` | Date | Requested transfer date |
| Status | `Status__c` | Picklist | Values: `Draft`, `Submitted` (not restricted) |
| Transfer Type | `Transfer_Type__c` | Picklist | Values: `1:1`, `1:N`, `N:1`, `N:N` (not restricted) |

#### 3.5.3 Standard FSC Object: `FundTransferRequest`
| Field | API Name | Type | Notes |
|-------|----------|------|-------|
| Name | `Name` | Auto Number | Auto-generated |
| Case | `CaseId` | Lookup (Case) | Parent case |
| From Account | `FromId` | Lookup (FinancialAccount) | Source account — **always required** |
| To Account | `ToId` | Lookup (FinancialAccount) | Destination account — **always required** |
| Amount | `Amount` | Currency | Amount for this FROM→TO pair — **always required** |
| Start Date | `StartDate` | Date | Requested transfer date |
| Status | `Status` | Picklist | Values depend on org configuration |
| Transfer Type | `TransferType` | Picklist | **Restricted picklist** — values `1:1`, `1:N`, `N:1`, `N:N` must be added in Setup → Object Manager → FundTransferRequest → TransferType → Edit Values before use |

> **Platform constraint:** `FundTransferRequest` requires **both `FromId` and `ToId` to be set** on every record. Source-only or destination-only records fail a platform validation rule ("Amount is required unless Recurring Payment Option is provided"). Every saved record therefore represents a specific FROM→TO pair.

#### 3.5.4 Paired Record Strategy per Transfer Type
| Transfer Type | Records Created | FromId | ToId | Amount per record |
|---|---|---|---|---|
| **1:1** | 1 | single source | single destination | source amount |
| **1:N** | N (one per destination) | same source | each destination | destination amount |
| **N:1** | N (one per source) | each source | same destination | source amount |
| **N:N** | ≤ M+N−1 (waterfall) | see §3.5.5 | see §3.5.5 | see §3.5.5 |

#### 3.5.5 N:N Waterfall Distribution Algorithm
For N:N transfers, the system uses a greedy waterfall to create the minimum number of FROM→TO pairs while preserving source and destination totals exactly:

1. Maintain a remaining-balance list for each source and destination
2. Walk two pointers (source index `si`, destination index `di`) simultaneously
3. At each step, pair amount = `min(srcRemaining[si], dstRemaining[di])`
4. Create one `FundTransferRequest` record for that pair and amount
5. Subtract the pair amount from both remaining balances; advance the pointer whose balance reaches zero
6. Repeat until all accounts are exhausted

This produces at most **M + N − 1** records (where M = source count, N = destination count). The pairing order follows the order accounts were selected in the UI.

#### 3.5.6 Edit Behaviour
- Saving an edited transfer (Draft or Submit) **replaces** all existing records for the case atomically: existing records are deleted and the new set is inserted in the same transaction
- The UI pre-populates the form on Edit with the existing accounts and amounts read from `wiredSummary`

**Priority:** P0 (Core)

---

### 3.6 Data Display in Case (F6)
**Requirement:** Transfer configurations shall be visible and easily readable within the case context.

**Details:**

**List mode (default view):**
- Shows transfer date, status badge
- Two-column layout: Source Accounts (left) | Destination Accounts (right)
- Each account shown with masked account number (`Type • ****XXXX`) and aggregated amount
- Amounts are aggregated per unique account across all paired records (a source appearing in multiple pairs shows its total outgoing amount)
- **Edit** button → switches to form mode with data pre-populated
- **Reset** button → confirmation dialog → deletes all transfer records for the case

**Empty state:**
- When no records exist: icon, help text, and "New Transfer Request" button

**Form mode:**
- Transfer date input
- Source column: account picker (sorted by balance) + selected account cards + running total
- Destination column: same structure
- Actions: Save as Draft / Submit / Cancel

**Priority:** P1 (High)

---

### 3.7 Error Handling & User Feedback (F7)
**Requirement:** System shall provide clear error messaging and validation feedback.

**Details:**
- **Validation errors** shown inline above the form actions
- **Insufficient balance:** `"Account ****XXXX has $X,XXX available but $X,XXX requested."`
- **Total mismatch:** shown as an inline warning in real time; blocks submission
- **Missing fields:** `"All amount fields must be greater than zero."`, `"Transfer date is required."`
- **Success:** toast notification on successful Draft save or Submit
- **Apex errors:** DML errors, field errors, and `AuraHandledException` messages all surface correctly via `_extractError()` in the LWC

**Priority:** P0 (Core)

---

### 3.8 Access Control (F8)
**Requirement:** Users must be granted explicit access to the custom object and Apex controller via a permission set.

**Details:**
- Permission set: **Transfer Configuration User** (`Transfer_Configuration_User`)
- Grants:
  - Create / Read / Edit / Delete on `Fund_Transfer_Request__c`
  - Read + Edit on all seven custom fields
  - Apex class access for `TransferConfigurationController`
- Assign to teller profiles via Setup → Permission Sets → Manage Assignments
- When switching to the standard `FundTransferRequest` object, a separate permission set or profile update is required for that object

**Priority:** P0 (Core)

---

## 4. SYSTEM CONSTRAINTS & BUSINESS RULES

### 4.1 Account Limits
- No upper limit on the number of source or destination accounts per transfer
- Accounts are loaded via `FinancialAccountParty` with a SOQL `LIMIT 200` safeguard

### 4.2 Amount Rules
- All amounts must be **positive numbers greater than zero**
- Currency formatting automatically applied in the UI
- Draft saves do not enforce balance or total-match constraints
- Submit enforces both balance and source/destination total-match constraints

### 4.3 Account Selection Rules
- The same account **cannot appear in both source and destination** — enforced structurally by the shared available pool (selecting an account removes it from both dropdowns)
- An account **cannot be selected twice** in the same column — also enforced structurally by the shared pool
- Accounts must belong to the customer context of the parent case
- Only accounts with `FinancialAccountParty.Role = 'Owner'` and `FinancialAccount.Status = 'Active'` are shown

### 4.4 Balance Validation Timing
- Balance is loaded at component initialisation via `getFinancialAccounts` wire
- Validation against balance is performed client-side on Submit
- Balance displayed on each selected account card for reference during amount entry

### 4.5 `@AuraEnabled` Parameter Constraint
- Salesforce's `@AuraEnabled` framework silently nullifies `List<CustomInnerClass>` method parameters
- **Workaround:** The LWC serialises the entire save payload as a single JSON string (`payloadJson`) which Apex deserialises explicitly using `JSON.deserialize`. This is the implemented pattern and must be maintained if the method signature is modified

---

## 5. USER INTERFACE SPECIFICATIONS

### 5.1 Component Modes

The component operates in two modes, toggled by user action:

**List Mode (default)**
```
┌──────────────────────────────────────────────────┐
│  Transfer Requests                               │
├──────────────────────────────────────────────────┤
│  Transfer Date: June 17, 2026   Status: [Draft]  │
│                                                  │
│  Source Accounts      │  Destination Accounts    │
│  ─────────────────    │  ─────────────────────   │
│  Savings • ****1234   │  Checking • ****5678     │
│                $300   │                  $300    │
│                                                  │
│  [ Edit ]  [ Reset ]                             │
└──────────────────────────────────────────────────┘
```

**Form Mode (New / Edit)**
```
┌──────────────────────────────────────────────────┐
│  Transfer Requests                               │
├──────────────────────────────────────────────────┤
│  Transfer Date: [__________]                     │
│                                                  │
│  Source Accounts       │  Destination Accounts   │
│  ──────────────────    │  ────────────────────   │
│  [Add source acct ▼]   │  [Add dest acct   ▼]   │
│                        │                         │
│  ┌──────────────────┐  │  ┌──────────────────┐  │
│  │ Savings ****1234 │  │  │ Checking ****5678│  │
│  │ Bal: $10,000     │  │  │ Bal: $5,000      │  │
│  │ Amount [$300] [🗑]│  │  │ Amount [$300] [🗑]│  │
│  └──────────────────┘  │  └──────────────────┘  │
│  Total: $300           │  Total: $300            │
│                                                  │
│  [ Save as Draft ]  [ Submit ]  [ Cancel ]       │
└──────────────────────────────────────────────────┘
```

### 5.2 Responsive Design
- Component optimised for desktop (primary use case: teller workstations)
- Deployed as a `lightning__RecordPage` component for both `Account` and `Case` objects, Large form factor only

### 5.3 User Interaction Flow

**New transfer:**
1. Teller opens Case record → sees empty state with "New Transfer Request" button
2. Clicks New → form mode opens
3. Selects transfer date
4. Picks source account(s) from the shared dropdown (sorted by balance descending)
5. Picks destination account(s) from the same shared dropdown
6. Enters amounts for each selected account — running totals update live
7. Clicks **Save as Draft** (skips balance and total-match checks) or **Submit** (full validation)
8. On success: toast notification, form resets, list mode shows the saved summary

**Edit transfer:**
1. Teller clicks **Edit** on the list view
2. Form opens pre-populated with existing accounts and amounts
3. Teller modifies accounts or amounts as needed
4. Saves — existing records deleted and new set inserted atomically

**Reset transfer:**
1. Teller clicks **Reset** → confirmation dialog
2. On confirm: all `Fund_Transfer_Request__c` records for the case are deleted
3. Component returns to empty state

---

## 6. TECHNICAL ARCHITECTURE

### 6.1 Data Model

```
Case
  └─ Fund_Transfer_Request__c / FundTransferRequest (one record per FROM→TO pair)
       ├─ From_Account__c / FromId → FinancialAccount (source — always required)
       └─ To_Account__c  / ToId   → FinancialAccount (destination — always required)

Account (Customer)
  └─ FinancialAccountParty (junction — Role = 'Owner')
       └─ FinancialAccount
            └─ FinancialAccountBalance (most recent by BalanceAsOfDate DESC, CreatedDate DESC)
```

### 6.2 Component Stack

| Layer | Technology | Detail |
|-------|-----------|--------|
| Frontend | Lightning Web Component | `transferConfiguration` — dual-mode (list/form) |
| Backend | Apex | `TransferConfigurationController` — with sharing |
| Storage | Custom or Standard object | Switched by `USE_STANDARD_OBJECT` constant |
| Access | Permission Set | `Transfer_Configuration_User` |

### 6.3 Apex Controller Methods

| Method | Type | Purpose |
|--------|------|---------|
| `getFinancialAccounts(accountId)` | `@AuraEnabled(cacheable=true)` | Returns active financial accounts for the customer, with most recent balance |
| `getTransferSummary(caseId)` | `@AuraEnabled(cacheable=true)` | Returns aggregated source/destination summary from existing transfer records |
| `saveTransferRequests(payloadJson)` | `@AuraEnabled` | Deletes existing records for the case and inserts the new set; applies waterfall for N:N |
| `deleteTransferRequests(caseId)` | `@AuraEnabled` | Deletes all transfer records for the case (Reset action) |

### 6.4 Object Switch Constants

```apex
private static final Boolean USE_STANDARD_OBJECT = false;

private static final String OBJ    = USE_STANDARD_OBJECT ? 'FundTransferRequest'  : 'Fund_Transfer_Request__c';
private static final String F_CASE = USE_STANDARD_OBJECT ? 'CaseId'               : 'Case__c';
private static final String F_FROM = USE_STANDARD_OBJECT ? 'FromId'               : 'From_Account__c';
private static final String F_TO   = USE_STANDARD_OBJECT ? 'ToId'                 : 'To_Account__c';
private static final String F_AMT  = USE_STANDARD_OBJECT ? 'Amount'               : 'Amount__c';
private static final String F_DATE = USE_STANDARD_OBJECT ? 'StartDate'            : 'Start_Date__c';
private static final String F_STAT = USE_STANDARD_OBJECT ? 'Status'               : 'Status__c';
private static final String F_TYPE = USE_STANDARD_OBJECT ? 'TransferType'         : 'Transfer_Type__c';
```

All SOQL, DML, and field access uses these constants. Changing `USE_STANDARD_OBJECT` to `true` and redeploying the Apex class is the only migration step required.

### 6.5 Deployed Metadata

| Artifact | Type | Purpose |
|----------|------|---------|
| `transferConfiguration` | LWC | UI component |
| `TransferConfigurationController` | Apex Class | Backend logic |
| `Fund_Transfer_Request__c` | Custom Object | Transfer records (dev org) |
| `Transfer_Configuration_User` | Permission Set | Field/object/class access for tellers |

### 6.6 Integration Points
- **Inbound:** Case object context (customer, case ID); Account page also supported (read-only view; saves require Case context)
- **Outbound:** Transfer data stored in Salesforce; external transfer system reads via API
- **No external API calls** in this scope

---

## 7. OUT OF SCOPE

1. **Actual Fund Transfer Execution** — backend/external system responsibility
2. **Audit Trail & Compliance** — regulatory compliance features (AML, KYC, etc.)
3. **Approval Workflows** — no manual approval steps required
4. **Inter-Bank Transfers** — transfers limited to accounts within Salesforce
5. **Transfer Scheduling** — future-dated transfers beyond the transfer date field
6. **Fee Calculation** — no fee computation or display
7. **Multi-Currency** — assumed single currency environment
8. **Reporting & Analytics** — dashboards and reports on transfers
9. **Mobile App** — desktop-first implementation; mobile form factor not configured
10. **Configurable Account Query (CMT)** — account query is currently hardcoded to `FinancialAccountParty` with `Role = 'Owner'` and `Status = 'Active'`; CMT-based configuration is a future enhancement

---

## 8. FUTURE ENHANCEMENTS (Post-MVP)

1. **Migrate to Standard Object** — set `USE_STANDARD_OBJECT = true` once `FundTransferRequest.TransferType` picklist values are configured in the target org
2. **Approval Workflows** — add approval routing for high-value transfers
3. **Audit & Compliance** — regulatory compliance features
4. **Transfer Scheduling** — schedule transfers for future execution dates
5. **Templates** — save and reuse transfer configurations
6. **Bulk Upload** — CSV/Excel import for multiple transfers
7. **Analytics Dashboard** — track transfer volumes and patterns
8. **Configurable Account Query** — CMT-driven SOQL filter and sort for account dropdowns
9. **Notification System** — email/SMS notifications on transfer completion

---

## 9. ACCEPTANCE CRITERIA

### 9.1 Functional Acceptance Criteria
- [x] Transfer type inferred automatically from account counts; stored on the record
- [x] Account dropdowns show all active accounts for the customer sorted by balance descending
- [x] Selecting an account removes it from both dropdowns; trashing it restores it to both
- [x] Selected account rows show name, masked account number, balance, amount input, and remove button
- [x] Individual amounts can be entered per account on each side
- [x] Running totals displayed per column; mismatch warning shown in real time
- [x] Balance validation (Submit only) prevents transfers that exceed available balance
- [x] Total-match validation (Submit only) prevents submission when source ≠ destination total
- [x] Draft save bypasses balance and total-match checks
- [x] Transfer configuration saves atomically to `Fund_Transfer_Request__c` as paired FROM→TO records
- [x] N:N transfers use the waterfall algorithm; produce at most M+N−1 records
- [x] List view shows aggregated source/destination accounts and amounts
- [x] Edit pre-populates the form with existing accounts and amounts
- [x] Save on edit replaces existing records atomically (delete + insert in one transaction)
- [x] Reset deletes all transfer records after confirmation
- [x] Component embeddable on both Account and Case record pages
- [x] Error messages are clear and actionable; Apex errors surface correctly

### 9.2 Performance Criteria
- Component loads within **2 seconds**
- Balance validation completes within **1 second**
- Form submission completes within **3 seconds**
- Dropdown accounts populate within **1 second** of component load

### 9.3 Data Integrity Criteria
- Every `Fund_Transfer_Request__c` record has both `From_Account__c` and `To_Account__c` populated
- All records for a transfer share the same `Case__c`, `Start_Date__c`, `Status__c`, and `Transfer_Type__c`
- Saving an edit never results in orphaned or duplicate records

---

## 10. GLOSSARY

| Term | Definition |
|------|-----------|
| **HNW Customer** | High-Net-Worth customer with multiple accounts and complex banking needs |
| **Transfer Configuration** | The complete definition of a multi-account transfer (sources, destinations, amounts) |
| **Paired Record** | A single `Fund_Transfer_Request__c` record representing one FROM→TO account pair with an amount |
| **Waterfall Algorithm** | Greedy two-pointer algorithm that creates the minimum number of FROM→TO pairs for N:N transfers while preserving source and destination totals exactly |
| **Available Pool** | The set of financial accounts not yet selected in either column; drives both source and destination dropdowns |
| **USE_STANDARD_OBJECT** | Boolean constant in `TransferConfigurationController` that switches between the custom and standard storage objects |
| **Financial Account** | Salesforce FSC standard object representing a customer's bank account (`FinancialAccount`) |
| **Balance Validation** | Check performed on Submit that ensures each source account's entered amount does not exceed its available balance |

---

## 11. DOCUMENT REVISION HISTORY

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 6, 2026 | | Initial functional requirements draft |
| 2.0 | June 7, 2026 | | Updated to reflect implemented solution: dual-object architecture, shared pool UI, waterfall N:N algorithm, inferred transfer type, permission set, paired record strategy, edit pre-population |

---

**Sign-Off:**

- **Product Owner:** _________________ Date: _______
- **Requirements Lead:** _________________ Date: _______
- **Technical Lead:** _________________ Date: _______
