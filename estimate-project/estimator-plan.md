# AI Estimator SaaS — Implementation Plan

## Problem Statement
Build a multi-tenant SaaS platform where home service / contracting business owners (tenants) can:
1. Upload their business knowledge (SOPs, price books, manuals, photos, videos)
2. Chat with a trained AI estimator to generate job estimates in their own voice/style
3. Have a second QC agent validate those estimates
4. Feed real corrections back into the system so the AI continuously improves

**Tech Stack:**
- Frontend + API: Next.js on Cloudflare Pages + Workers
- Database + Auth: Supabase (PostgreSQL + Auth + pgvector + Storage)
- AI Inference: Cloudflare Workers AI (no external API keys, cheapest)

---

## Architecture Overview

```
Tenant Browser (Next.js UI)
        │
        ▼
Cloudflare Pages (Next.js static + SSR)
        │
        ▼
Cloudflare Workers (Next.js API routes)
        │
   ┌────┴────────────────────────┐
   │                             │
Supabase DB                Cloudflare Workers AI
(PostgreSQL + pgvector)    (Inference + Embeddings + Vision)
   │
Supabase Storage
(Raw files: PDFs, images, videos)
```

### Data Isolation
Every table has a `tenant_id` column. Supabase Row-Level Security (RLS) enforces that
tenants can only see their own data.

---

## AI Models (Cloudflare Workers AI)

| Purpose | Model |
|---|---|
| Text generation / chat (Estimator & QC) | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Text embeddings (RAG knowledge indexing) | `@cf/baai/bge-large-en-v1.5` |
| Image / photo analysis | `@cf/llava-hf/llava-1.5-7b-hf` |
| Video (frame extraction → image model) | Extract keyframes server-side → vision model |

> Note: Cloudflare Workers AI models are smaller than GPT-4o. For complex
> multi-step reasoning, chain multiple model calls (retrieval → generation → QC).

---

## Core Modules

### 1. Auth & Tenant Management
- Supabase Auth (email/password + magic link)
- Each signup creates a `tenants` row with their business profile
- Supabase RLS on all tables using `auth.uid()` → `tenant_id`
- Tables: `tenants`, `tenant_settings`

### 2. Business Profile & Personality Configuration
- Tenant fills in: company name, location, staffing roles, billing rules (travel zones, rates), brand tone/personality
- This structured data is serialized into a "system prompt template" stored per tenant
- Table: `tenant_profiles` (name, address, roles, billing_rules, tone_description, system_prompt_override)

### 3. Knowledge Base (RAG Pipeline)
The heart of the system. Each tenant has an isolated knowledge base.

**Ingestion pipeline:**
```
Upload file (PDF/image/video)
        │
        ▼
Store raw file → Supabase Storage (bucket: knowledge-files/{tenant_id}/)
        │
        ▼
Process based on type:
  PDF/text → chunk into ~512 token segments
  Image    → CF Workers AI vision model → text description
  Video    → extract keyframes (ffmpeg in Worker or Edge Function) → vision model per frame → aggregate text
        │
        ▼
Embed text chunks → CF Workers AI bge-large embeddings → float[] vectors
        │
        ▼
Store in Supabase pgvector table: `knowledge_chunks`
  (id, tenant_id, source_file_id, chunk_text, embedding vector(1024), metadata jsonb)
```

**Tables:**
- `knowledge_files` (id, tenant_id, file_name, file_type, storage_path, status, created_at)
- `knowledge_chunks` (id, tenant_id, file_id, chunk_text, embedding vector(1024), chunk_index, metadata)

**Supabase pgvector index:** `ivfflat` or `hnsw` on `embedding` column, filtered by `tenant_id`

### 4. Estimator Agent (Primary)
The main AI assistant contractors use to generate estimates.

**Flow:**
```
Contractor submits: job description text + optional photos/videos
        │
        ▼
[Media step] If photos/videos: run CF vision model → extract text descriptions
        │
        ▼
[RAG step] Embed the job query → vector similarity search in knowledge_chunks (tenant-scoped)
           → retrieve top-K relevant chunks (price book items, SOPs, billing rules)
        │
        ▼
[Generation step] Build prompt:
  system: tenant's personality/tone + business profile
  context: retrieved knowledge chunks
  user: job description + media descriptions
  → CF Workers AI llama-70b → structured estimate (scope of work + price breakdown)
        │
        ▼
Store conversation + estimate → `estimate_sessions` table
```

**Tables:**
- `estimate_sessions` (id, tenant_id, job_description, media_refs[], retrieved_chunks[], raw_estimate, final_estimate, status, created_at)
- `estimate_messages` (id, session_id, role, content, created_at) — for multi-turn chat

### 5. QC / Validation Agent (Secondary)
A second agent that independently reviews and validates the primary estimate.

**Flow:**
```
Primary estimate output
        │
        ▼
QC prompt: "You are a quality control reviewer. Check this estimate for:
  - Math accuracy
  - Missing line items
  - Scope completeness
  - Alignment with the price book (retrieved chunks provided)
  Output: PASS / FAIL with specific issues listed"
        │
        ▼
CF Workers AI → QC report
        │
        ▼
Store QC report alongside estimate. Surface warnings in UI.
```

**Column additions to `estimate_sessions`:** `qc_report jsonb`, `qc_status` (pass/fail/warning)

### 6. Feedback / Learning Loop
When a contractor modifies an AI estimate, that correction is fed back as knowledge.

**Flow:**
```
Contractor edits and approves final estimate
        │
        ▼
System stores: original AI estimate + contractor's final version + diff
        │
        ▼
Create a new knowledge_chunk: "Context: [job type]. AI suggested: [X]. Correct response: [Y]."
        → Embed and insert into knowledge_chunks with metadata: { type: "correction", weight: high }
        │
        ▼
Future RAG queries will surface this correction when similar jobs appear
```

**Column additions to `estimate_sessions`:** `correction_applied bool`, `correction_note text`
**knowledge_chunks metadata:** `source_type` (sop | pricebook | correction | media_description)

---

## Next.js Page Structure

```
/app
  /(auth)
    /login
    /signup
  /(dashboard)
    /dashboard             — overview, recent estimates
    /knowledge             — upload & manage knowledge files
    /knowledge/[id]        — view chunks, status
    /profile               — business profile, personality, billing rules
    /estimator             — main chat UI (submit job → get estimate)
    /estimator/[id]        — view session, QC report, approve/correct
    /settings              — plan, billing, account
```

---

## Cloudflare-Specific Considerations

| Concern | Solution |
|---|---|
| Workers CPU time limit (30ms CPU / 30s wall) | Heavy embedding jobs → Cloudflare Queues + background Worker |
| Workers memory (128MB) | Stream large files; don't buffer entire video in Worker |
| Video frame extraction | Use Supabase Edge Function (Deno) with ffmpeg-wasm, or offload to a dedicated long-running Worker with Durable Objects |
| Next.js on CF Pages | Use `@cloudflare/next-on-pages` adapter; use `edge` runtime for API routes |
| Env vars / secrets | CF Pages env vars + Wrangler secrets for Supabase keys |
| R2 vs Supabase Storage | Use Supabase Storage (S3-compatible) — simpler with single vendor |

---

## Database Schema Summary

```sql
tenants (id, owner_user_id, name, created_at)
tenant_profiles (tenant_id, company_name, address, roles jsonb, billing_rules jsonb, tone text, system_prompt text)
knowledge_files (id, tenant_id, file_name, file_type, storage_path, status, created_at)
knowledge_chunks (id, tenant_id, file_id, chunk_text, embedding vector(1024), chunk_index, metadata jsonb)
estimate_sessions (id, tenant_id, job_description, media_refs jsonb, raw_estimate text, final_estimate text, qc_report jsonb, qc_status text, correction_applied bool, correction_note text, status, created_at)
estimate_messages (id, session_id, tenant_id, role text, content text, created_at)
```

---

## Implementation Phases

### Phase 1 — Foundation
- Supabase project: Auth, schema, RLS policies, pgvector extension
- Next.js + Cloudflare Pages setup (`@cloudflare/next-on-pages`)
- Tenant onboarding: signup → business profile form
- Knowledge file upload UI → Supabase Storage

### Phase 2 — RAG Pipeline
- File processing Worker: PDF chunking, image vision, video frame extraction
- Cloudflare Queue for async embedding jobs
- Embedding storage in pgvector
- Semantic search API endpoint (tenant-scoped)

### Phase 3 — Estimator Agent
- System prompt builder (uses tenant profile + retrieved chunks)
- Chat UI for estimator
- Media upload in estimate session
- Estimate session storage

### Phase 4 — QC Agent
- Secondary validation prompt chain
- QC report display in UI
- Pass/fail/warning status

### Phase 5 — Feedback Loop
- Estimate approval / correction flow
- Correction-as-knowledge ingestion
- Correction weighting in RAG retrieval

### Phase 6 — SaaS Layer
- Subscription / plan management (Stripe)
- Usage limits (knowledge file cap, estimate count)
- Tenant admin dashboard (usage stats)

---

## Open Questions / Decisions
- **Video processing**: ffmpeg-wasm in Edge Function vs. a separate lightweight server (e.g., a simple Node service). ffmpeg-wasm is ~30MB and slow — may need a dedicated Worker with extended CPU via Durable Objects or a small external service.
- **Embedding model dimension**: `bge-large-en-v1.5` outputs 1024d vectors. Verify Supabase pgvector index performance at tenant scale.
- **Model quality**: llama-3.3-70b on CF Workers AI is strong but requires testing against real estimating scenarios. A fallback to OpenAI can be added per-tenant if quality is insufficient.
