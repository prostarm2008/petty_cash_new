# Petty Cash Ledger — columns and types the Flow must accept

Derived from the trigger-schema error the Flow actually returned:

> `TriggerInputSchemaMismatch` — Invalid type. Expected Integer but got String.,
> Invalid type. Expected Array but got String., Invalid type. Expected Array but got String.

**Types matter as much as the column names.** Excel returns every column as text, so a record
read back and pushed again arrives with the wrong types unless the client re-coerces it — which
is what was breaking the branch upload.

---

## Columns declared as ARRAY in the trigger schema

| Column | JSON type | Contents |
|---|---|---|
| `supportingDocs` | **Array** | Objects of `{id, name, mime, size, uploadedBy, uploadedOn, url}`. File bytes are never sent. |
| `auditTrail` | **Array** | Objects of `{action, from, to, remark, actor, role, at}`. Append-only. |

Sending these as JSON strings produces *"Expected Array but got String"*. Sending them as
arrays containing base64 file data breaches the 32,767-character cell limit. Both are avoided:
arrays go as arrays, carrying metadata only.

## Columns declared as INTEGER / NUMBER

| Column | Notes |
|---|---|
| `year` | The field that caused the Integer error — Excel returns `"2026"`, the schema wants `2026`. |
| `expenseAmount` | Coerced on both read and write. |
| `receivedAmount` | Coerced on both read and write. |
| `docCount` | Number of supporting documents. |
| `auditCycleCount` | Query cycles this line item has been through. |
| `reqOriginalAmount` | Requisition amount before negotiation, where applicable. |

## Workflow columns (text)

| Column | Notes |
|---|---|
| `wfStatus` | SUBMITTED / PENDING_RM / RETURNED_RM / PENDING_FA / RETURNED_FA / AUDITED / NA. **Without this the RM and Auditor queues stay empty.** |
| `docNames` | Comma-separated file names. Convenience column for reporting. |
| `docsSubmittedOn` | When the branch submitted for verification. Drives RM ageing. |
| `rmApprovedBy` / `rmApprovedOn` | Regional Manager release. |
| `auditedBy` / `auditedOn` | Finance Auditor sign-off. |
| `returnedBy` / `returnedOn` / `returnRemark` / `returnReason` | Return path. |
| `reviewRemark` | Most recent reviewer remark. |
| `docImageOversize` | `Y` when the entry-time voucher image was too large to store. |

## Requisition linkage (transferred entries only)

`reqNo` · `reqId` · `reqApprovedBy` · `reqApprovedOn` · `reqOriginalAmount` (number) · `sourceType`

---

## If you would rather not maintain the trigger schema

In the Flow trigger, **Use sample payload to generate schema** and paste a current record, or
simply clear the schema so the trigger accepts any JSON body. A hand-maintained schema has to be
updated every time a column is added, and a mismatch fails the whole write with no partial save.

## Document bytes

A 200 KB attachment is roughly 273,000 characters of base64; an Excel cell holds 32,767. The sheet
therefore stores document *metadata* only. A file is viewable on the machine that uploaded it;
other users see the name, uploader and timestamp.

To make files viewable everywhere, add a SharePoint document library, upload the file there, and
return the URL into the `url` field of each `supportingDocs` entry. The app already prefers `url`
over local bytes wherever a document is rendered, so that single field is the whole change.