My friend suggest the following for the feedback loop:

Contractor edits and approves final estimate
        │
        ▼
Store: AI JSON, final JSON, diff, job tags
        │
        ▼
Create correction record (NOT immediately a high-weight canonical chunk) IMPPP
- Save as source_type="correction"
- Add metadata: job_type, category, region, confidence, created_at
        │
        ▼
Retrieval policy:
- Retrieve canonical sources first (pricebook/SOP)
- Retrieve corrections as secondary channel (scoped + decayed)
        │
        ▼
Promotion rule (optional but recommended):
- If same correction repeats N times OR admin approves → promote to “canonical guidance” (This will be the best way to improve the model over time but keep N at a good level)