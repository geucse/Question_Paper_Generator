// Institutional identity used by the shell and the login screen. Values come from the build environment so a
// deployment sets them without code changes (see frontend/BRANDING.md):
//   VITE_INSTITUTION_NAME  name shown beside the product name (default "Graphic Era")
//   VITE_BRAND_LOGO_URL    URL of the institution-approved logo (e.g. /brand/graphic-era-logo.svg). Leave unset until
//                          the official file is supplied: the shell then shows the name as text, never a redrawn logo.
export const BRAND = {
  institution: import.meta.env.VITE_INSTITUTION_NAME || 'Graphic Era',
  product: 'Examination Portal',
  logoUrl: import.meta.env.VITE_BRAND_LOGO_URL || '',
};

export const ROLE_NAMES = {
  teacher: 'Teacher', hod: 'Head of Department', reviewer: 'Reviewer', coe: 'Controller of Examinations',
  validator: 'Paper validator', admin: 'Technical administrator',
};

// What each role's workspace is for, in the words of the people using it.
export const WORKSPACES = {
  teacher: ['Question authoring', 'Write questions, submit them for review and follow each one through its lifecycle.'],
  hod: ['Department question bank', 'Prepare syllabus versions, run review batches and keep the bank ready for examinations.'],
  reviewer: ['Question review', 'Verify classification and quality, record verdicts in review batches and activate approved questions.'],
  coe: ['Examination office', 'Create examinations, generate papers to exact CO and Bloom targets, assign validators and approve papers for print.'],
  validator: ['Paper validation', 'Check each assigned paper against the checklist, report issues and record your decision.'],
  admin: ['System administration', 'Accounts, access scopes, policies and platform health. Academic content cannot be changed from here.'],
};
