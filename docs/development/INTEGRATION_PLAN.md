> **SUPERSEDED.** This was the working checklist for the first pivot pass. Most unchecked items below were implemented
> later; the current state is in `/docs/development/PIVOT_STATUS.md`. Kept for history only.

# PIVOT Integration Plan
**Generated: 2026-10-04**

## Backend Updates Required

### 1. Questions Routes (questions.js)
- [x] Add `requireAuth` middleware (already has it)
- [ ] Replace `is_draft`/`status` with `question_status` (9 states)
- [ ] Add authorization checks via `authorize()` for:
  - Create/update draft: scope check (teacher's campus/program)
  - Submit: validate state transition DRAFT → SUBMITTED
  - Review/approve: HOD/reviewer scope + conflict checks
- [ ] Block editing of ACTIVE questions
- [ ] Update queries to use `question_status` column

### 2. Papers Routes (papers.js)
- [ ] Add `requireAuth` middleware
- [ ] Replace with `examinations.js` + `coe-approval.js` logic
- [ ] Deprecate old paper generation (use ACTIVE-only generator)
- [ ] Add paper_status checks (DRAFT/VALIDATION_PENDING/VALIDATED/COE_APPROVED/PRINT_READY)

### 3. Review Routes (review.js)
- [ ] Add authorization checks for reviewer assignments
- [ ] Validate reviewer ≠ question author
- [ ] Update to use question_status state machine
- [ ] Add transition validation (SUBMITTED → IN_REVIEW → APPROVED)

### 4. Server Registration (server.js)
- [x] Register `examinationRoutes`
- [x] Register `coeApprovalRoutes`
- [ ] Verify all routes use `requireAuth`

## Frontend Updates Required

### 1. Question Bank UI
**Files to create/update:**
- `frontend/src/components/QuestionStatusBadge.jsx` - Display question_status with color coding
- `frontend/src/pages/Questions/QuestionList.jsx` - Update to show new states
- `frontend/src/pages/Questions/QuestionForm.jsx` - Block editing of ACTIVE questions

**Features:**
- State badges: DRAFT (gray), SUBMITTED (blue), IN_REVIEW (yellow), APPROVED (green), ACTIVE (dark green), REJECTED (red)
- State transition buttons (Submit, Approve, Activate)
- Lifecycle timeline visualization

### 2. COE Dashboard
**Files to create:**
- `frontend/src/pages/COE/COEDashboard.jsx` - Main dashboard
- `frontend/src/pages/COE/ExaminationCreate.jsx` - Create examination form
- `frontend/src/pages/COE/PaperGenerate.jsx` - Generate paper from ACTIVE questions
- `frontend/src/pages/COE/ValidatorAssignment.jsx` - Assign 4 validators
- `frontend/src/pages/COE/COEApproval.jsx` - Final approval with TOTP

**Features:**
- Examination list with filters
- Paper generation wizard
- Validator selection (exactly 4, conflict checks)
- TOTP input for approval
- Paper status tracking

### 3. Validator Dashboard
**Files to create:**
- `frontend/src/pages/Validator/ValidatorDashboard.jsx` - Assigned papers list
- `frontend/src/pages/Validator/PaperValidation.jsx` - Validation checklist
- `frontend/src/pages/Validator/IssueReport.jsx` - Report issues

**Features:**
- Assigned papers with deadlines
- Validation checklist (formatting, difficulty, CO alignment, etc.)
- Approve/Changes Required workflow
- Issue reporting with categories

### 4. Navigation & Routing
**Files to update:**
- `frontend/src/App.jsx` - Add protected routes
- `frontend/src/components/Navbar.jsx` - Role-based menu items
- `frontend/src/routes/ProtectedRoute.jsx` - Route guards

**Features:**
- Show "Examinations" tab for COE
- Show "Validation" tab for validators
- Hide "Question Bank" from COE/validators (examination domain separation)

## Priority Order
1. ✅ Backend: New routes created (examinations.js, coe-approval.js)
2. **NEXT**: Backend: Update questions.js for lifecycle states
3. **NEXT**: Frontend: Question status badge + list updates
4. Backend: Update review.js authorization
5. Frontend: COE dashboard (basic)
6. Frontend: Validator dashboard (basic)
7. Frontend: Navigation updates
8. Integration testing

## Migration Strategy
- Keep old columns (`is_draft`, `status`) for backward compatibility during transition
- New code uses `question_status` exclusively
- Frontend checks `question_status` first, falls back to old columns if null
- Remove old columns after full migration confirmed working
