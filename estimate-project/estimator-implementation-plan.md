# AI Estimator SaaS — Implementation Plan

## Context

Home service / contracting business owners spend hours manually quoting jobs. Community research
(temp----estimiate-pain.md) shows owners are solving this by training custom GPTs with their own
SOPs, price books, and brand voice — but the process is manual, non-scalable, and per-person.

This plan builds a multi-tenant SaaS where each contractor gets an isolated AI estimator trained on
their own business knowledge, with a QC validation agent and a feedback loop to improve over time.

---

## AI Deployment — The Core Question

**No dedicated AI server is needed.** All AI inference runs serverless via Cloudflare Workers AI —
a fully managed, pay-per-use GPU service on Cloudflare's global edge network. You provision nothing.
There are no GPUs to rent, no servers to manage, no model hosting costs. You call the API; they run
the model.

### AI Models (all on Cloudflare Workers AI)

| Purpose | Model | Notes |
|---|---|---|
| Estimator + QC chat | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Fast 70B — strong reasoning |
| Text embeddings (RAG) | `@cf/baai/bge-large-en-v1.5` | 1024d vectors, good semantic search |
| Photo / image analysis | `@cf/meta/llama-3.2-11b-vision-instruct` | Upgrade from llava-1.5-7b (better) |
| Video (keyframes) | Extract frames → image model above | Server-side keyframe extraction |

> **llava-1.5-7b-hf** (original plan) still works but `llama-3.2-11b-vision-instruct` is stronger
> for understanding job site photos and is available on the same platform.

---

## Vendor Plans & Monthly Costs

### Required Services

| Vendor | Plan | Monthly Cost | What It Covers |
|---|---|---|---|
| **Cloudflare** | Workers Paid | $5/mo flat | Pages, Workers, Queues (now free tier included), Workers AI |
| **Supabase** | Pro | $25/mo flat | PostgreSQL + pgvector, Auth, Storage (100 GB), Edge Functions |
| **Workers AI usage** | Pay-per-use | ~$5–20/mo | Token usage beyond 10k free daily Neurons |

**Estimated total at launch (≤100 tenants): ~$35–50/month**

At scale (1,000 tenants, heavier use): ~$100–200/month. Still cheap.

### What Each Plan Unlocks

**Cloudflare Workers Paid ($5/mo):**
- Workers AI beyond 10,000 free Neurons/day ($0.011 per 1,000 extra Neurons)
- Cloudflare Queues (now also available on free plan as of Feb 4, 2026)
- No request limits hit in production

**Supabase Pro ($25/mo):**
- pgvector extension (also on free, but 500 MB DB is too small for multi-tenant vectors)
- 8 GB PostgreSQL + 100 GB file storage — handles PDFs, images
- No project pausing (free tier pauses after 7 days inactivity)
- Row-Level Security is free on all plans

### No Additional AI Vendor Needed

Cloudflare Workers AI covers all three AI tasks (LLM, embeddings, vision) in one account. No
OpenAI key, no Google API key, no separate embedding service. One vendor, one bill.

Optional fallback: If llama-70b quality is insufficient for complex estimates, add OpenAI GPT-4o
mini as a per-tenant opt-in ($0.15/$0.60 per 1M tokens) — but test first.

---

## Critical Tech Stack Corrections (vs original plan)

| Original Plan | Corrected |
|---|---|
| `@cloudflare/next-on-pages` | **Deprecated Sept 2025** → use `@opennextjs/cloudflare` |
| `@cf/llava-hf/llava-1.5-7b-hf` | Upgrade to `@cf/meta/llama-3.2-11b-vision-instruct` |
| ffmpeg-wasm in Supabase Edge Function | Use Cloudflare Worker (Durable Object) for video — Edge Function WASM is too constrained |
| Cloudflare Queues needs paid plan | **Free as of Feb 4, 2026** — works on free Workers plan |

---

## Architecture (Corrected)

```
Tenant Browser (Next.js UI)
        │
        ▼
Cloudflare Pages (Next.js via @opennextjs/cloudflare)
        │
        ▼
Cloudflare Workers (API routes — edge runtime)
        │
   ┌────┴──────────────────────────────────┐
   │                                        │
Supabase (Postgres + pgvector + Auth)   Cloudflare Workers AI
  + Supabase Storage (files: S3-compat)   (LLM + Embeddings + Vision)
        │                                        │
        └──── Cloudflare Queues ─────────────────┘
              (async embedding jobs)

Cloudflare Cron Trigger (nightly)
  → Promotion Worker: group correction_events by fingerprint
    → promote chunks hitting N threshold to canonical_guidance
```

### Data Isolation
Every table has `tenant_id`. Supabase RLS policies enforce `auth.uid() = tenant_id`. Tenants
cannot see each other's data at the database layer.

---

## Database Schema

```sql
-- Auth handled by Supabase Auth (auth.users)
tenants (id uuid PK, owner_user_id uuid FK → auth.users, name text, created_at)

tenant_profiles (
  tenant_id uuid PK FK → tenants,
  company_name text, address text,
  roles jsonb,            -- staffing roles
  billing_rules jsonb,    -- travel zones, rates
  tone text,              -- brand personality description
  system_prompt text,     -- compiled system prompt template
  promotion_n_threshold int DEFAULT 3  -- how many repeats before correction auto-promotes
)

knowledge_files (
  id uuid PK, tenant_id uuid, file_name text, file_type text,
  storage_path text, status text, created_at
)

knowledge_chunks (
  id uuid PK, tenant_id uuid, file_id uuid,
  chunk_text text, embedding vector(1024),
  chunk_index int,
  metadata jsonb
  -- metadata shape:
  -- {
  --   source_type: "sop" | "pricebook" | "correction" | "canonical_guidance" | "media",
  --   job_type: "painting" | "plumbing" | ...,   (for corrections)
  --   category: "labor" | "materials" | "travel" | ...,
  --   region: "zone-a" | null,
  --   confidence: 0.0–1.0,                        (starts at 0.6 for new corrections)
  --   repeat_count: int,                           (incremented each time same correction recurs)
  --   promoted_at: timestamp | null,               (set when promoted to canonical_guidance)
  --   created_at: timestamp
  -- }
)

estimate_sessions (
  id uuid PK, tenant_id uuid,
  job_description text, media_refs jsonb,
  retrieved_chunks jsonb,
  ai_estimate_json jsonb,       -- structured AI output (line items, totals)
  final_estimate_json jsonb,    -- contractor's approved version
  estimate_diff jsonb,          -- diff between ai and final (changed fields, delta values)
  job_tags text[],              -- e.g. ["painting", "interior", "residential"]
  qc_report jsonb, qc_status text,
  correction_applied bool,
  status text, created_at
)

-- Staging table for corrections before promotion
correction_events (
  id uuid PK, tenant_id uuid,
  session_id uuid FK → estimate_sessions,
  chunk_id uuid FK → knowledge_chunks,   -- the correction chunk created
  job_type text, category text, region text,
  ai_value text, corrected_value text,    -- what the AI said vs what contractor used
  fingerprint text,                        -- hash of (job_type + category + correction pattern)
                                           -- used to group repeated corrections
  created_at timestamp
)

estimate_messages (
  id uuid PK, session_id uuid FK → estimate_sessions,
  tenant_id uuid, role text, content text, created_at
)
```

pgvector index:
```sql
CREATE INDEX ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
-- Queries always filter by tenant_id in WHERE clause — Postgres will combine index + filter
```

---

## Core Module Flow

### 3. Knowledge Base — RAG Ingestion Pipeline

```
Upload file → Supabase Storage (knowledge-files/{tenant_id}/)
        │
        ▼ (Cloudflare Queue triggers background Worker)
  PDF/text  → chunk 512 tokens → embed → pgvector
  Image     → CF Vision model → text description → embed → pgvector
  Video     → Durable Object Worker → extract keyframes → vision per frame → embed → pgvector
```

### 4. Estimator Agent Flow

```
Job description + optional photos/videos
        │
[Media] CF llama-3.2-11b-vision → text descriptions of site conditions
        │
[RAG]   embed query → cosine search knowledge_chunks (tenant-scoped, top 8)
        │
[Gen]   system: tenant personality + business profile
        context: retrieved chunks (SOPs, price book, corrections)
        user: job description + media descriptions
        → CF llama-3.3-70b → structured estimate (scope + line-item pricing)
        │
Store → estimate_sessions
```

### 5. QC Agent Flow

```
Primary estimate
        │
QC system prompt: "Review this estimate for math accuracy, missing line items,
  scope completeness, and alignment with price book. Output: PASS/FAIL + issues."
        │
CF llama-3.3-70b (second call, different system prompt) → QC report
        │
Store qc_report + qc_status in estimate_sessions → surface in UI
```

### 6. Feedback Loop — Staged Correction System

The key design principle: **corrections are NOT immediately canonical**. A single contractor edit
could be a one-off mistake or a context-specific override. Only repeated, validated corrections
earn the right to influence future estimates.

```
Contractor edits estimate inline → approves final version
        │
        ▼
Store structured diff in estimate_sessions:
  - ai_estimate_json     (what the AI produced — line items, totals, scope)
  - final_estimate_json  (what the contractor approved)
  - estimate_diff        (field-level delta: what changed, by how much)
  - job_tags             (e.g. ["painting", "interior", "residential", "1200sqft"])
        │
        ▼
Create correction_chunk in knowledge_chunks:
  chunk_text = "Job type: [X]. Category: [Y]. AI estimated: [Z]. Correct value: [W]."
  source_type = "correction"          ← NOT canonical yet
  confidence  = 0.6                   ← starts moderate
  repeat_count = 1
  fingerprint = hash(job_type + category + correction_pattern)
        │
        ▼
Create correction_event record (links session → chunk, stores fingerprint)
        │
        ▼
─────────────── RETRIEVAL POLICY (on every estimate query) ───────────────
  Step 1: Retrieve canonical sources first
          WHERE source_type IN ('sop', 'pricebook', 'canonical_guidance')
          top 6 chunks by cosine similarity → HIGH trust, always included

  Step 2: Retrieve corrections as secondary channel
          WHERE source_type = 'correction'
            AND created_at > NOW() - INTERVAL '90 days'  ← time decay
          top 3 chunks by cosine similarity → LOWER trust, labeled as "past correction"
          (confidence score used to weight final ranking within this bucket)

  Merge: canonical chunks form the primary context block;
         correction chunks appended as: "[Past correction — treat as advisory]"
──────────────────────────────────────────────────────────────────────────
        │
        ▼
─────────────── PROMOTION RULE (background job, runs nightly) ────────────
  Query: GROUP BY fingerprint WHERE repeat_count >= N (default N=3)
         OR WHERE admin manually approved via dashboard

  On promotion:
    UPDATE knowledge_chunks SET source_type = 'canonical_guidance',
           confidence = 0.9, promoted_at = NOW()
    → This correction now retrieves at Step 1 priority (canonical tier)
    → Log promotion event for tenant audit trail

  Choosing N:
    - N=3 is the recommended default (3 independent jobs triggered same correction)
    - Tenant admin can lower to N=1 (trust own judgment) or raise to N=5 (stricter)
    - N is a per-tenant setting in tenant_profiles
──────────────────────────────────────────────────────────────────────────
```

**Why this matters:** A contractor who enters a wrong correction by accident doesn't corrupt the
model. Only patterns that repeat across multiple real jobs — proving they're systemic, not
one-offs — get promoted to influence all future estimates.

---

## Next.js Page Structure

```
/app
  /(auth)
    /login
    /signup
  /(dashboard)
    /dashboard              — overview, recent estimates
    /knowledge              — upload + manage knowledge files
    /knowledge/[id]         — view chunks, processing status
    /profile                — business profile, tone, billing rules, system prompt preview
    /estimator              — chat UI: submit job → get estimate
    /estimator/[id]         — view session, QC report, approve / correct estimate
    /settings               — plan, billing, account
```

---

## Implementation Phases

### Phase 1 — Foundation (Week 1–2)
- Init Supabase project: enable pgvector, create schema + RLS policies
- Init Next.js project with `@opennextjs/cloudflare` adapter
- Supabase Auth: email/password + magic link
- Tenant onboarding: signup → business profile form
- Knowledge file upload UI → Supabase Storage

### Phase 2 — RAG Pipeline (Week 2–3)
- Cloudflare Queue consumer Worker for async embedding jobs
- PDF chunking (pdf-parse or similar, no binary deps)
- CF Workers AI vision for image → text
- Durable Object Worker for video keyframe → vision pipeline
- pgvector storage + HNSW index
- Semantic search API endpoint (tenant-scoped)

### Phase 3 — Estimator Agent (Week 3–4)
- System prompt builder: merges tenant profile + retrieved chunks
- Chat UI for estimator (multi-turn)
- Media upload within estimate session
- Session storage + message history

### Phase 4 — QC Agent (Week 4)
- Second LLM call with QC system prompt
- QC report JSON schema + display in UI (pass/fail/warning badges)

### Phase 5 — Feedback Loop (Week 5)
- Inline estimate editor: AI output vs contractor edits, diff computed on save
- Correction chunk creation: source_type="correction", confidence=0.6, fingerprint hash
- correction_events staging table population
- Two-channel RAG retrieval: canonical first (top 6), corrections secondary (top 3, decayed)
- Nightly promotion job (Cloudflare Cron Trigger): group by fingerprint, promote at N hits
- Tenant admin dashboard panel: pending corrections, promote/reject manually, configure N
- Promoted correction audit log (who approved, when, how many repeats triggered it)

### Phase 6 — SaaS Layer (Week 6+)
- Stripe subscription (starter / pro / agency tiers)
- Usage limits: knowledge file count cap, estimate count/month
- Admin dashboard: usage stats, tenant overview

---

## Verification / Testing Approach

1. **Unit**: Test RAG pipeline with a sample PDF + 3 knowledge chunks → verify semantic search returns relevant chunks
2. **Integration**: Submit a test job ("paint 3 bedroom house, 1200 sqft") → verify estimate includes labor + materials from uploaded price book
3. **QC validation**: Submit a deliberately wrong estimate → verify QC agent flags the math error
4. **Feedback loop — staging**: Correct an estimate → verify correction chunk created with source_type="correction", NOT "canonical_guidance"; verify it appears in secondary RAG channel (labeled advisory), not in primary canonical block
5. **Feedback loop — promotion**: Simulate same correction N=3 times (3 sessions with same fingerprint) → run promotion job → verify chunk source_type changes to "canonical_guidance" and retrieves at top priority on next estimate
6. **Promotion guard**: Submit one-off unusual correction → verify it does NOT appear in primary RAG channel after a single occurrence; verify it decays after 90 days
7. **Multi-tenancy**: Create 2 tenants → upload different price books → verify estimate sessions and correction_events are isolated (RLS)
8. **Cost monitoring**: Track Cloudflare Workers AI Neurons via dashboard after 50 test estimates

---

## Open Questions Resolved

| Question | Answer |
|---|---|
| Dedicated AI server? | No — Cloudflare Workers AI is fully managed serverless GPU |
| Minimum viable plan? | Cloudflare Workers Paid ($5) + Supabase Pro ($25) = $30/mo base |
| Video processing? | Cloudflare Worker with Durable Object (not Edge Function — too constrained) |
| Next.js adapter? | @opennextjs/cloudflare (next-on-pages is deprecated) |
| Embedding dimensions? | 1024d (bge-large) — HNSW index on pgvector handles this well |
| Model quality fallback? | Add per-tenant OpenAI opt-in if llama-70b is insufficient |
