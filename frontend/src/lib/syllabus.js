import { useEffect, useState } from 'react';
import { api } from '../api';

// Syllabus version states (migration 042) as [badge class, label]. DRAFT -> TEACHER_VERIFIED -> HOD_REVIEW -> ACTIVE,
// ACTIVE -> SUPERSEDED when the next version is approved; REJECTED from any state before ACTIVE.
export const SYLLABUS_STATUS = {
  DRAFT: ['badge-draft', 'Draft'], TEACHER_VERIFIED: ['badge-pending', 'Content verified'], HOD_REVIEW: ['badge-pending', 'In HOD review'],
  ACTIVE: ['badge-approved', 'Active'], SUPERSEDED: ['badge-draft', 'Superseded'], REJECTED: ['badge-rejected', 'Rejected'],
};

// The uploaded-PDF source of a syllabus version, read from its stored extracted_units (any stored shape: null, a JSON
// string, an object, plain text). null when the version was not created from an uploaded PDF.
export function syllabusSource(extracted) {
  let v = extracted;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object' || v.source !== 'pdf') return null;
  const pages = Array.isArray(v.pages) && v.pages.length === 2 ? v.pages : null;
  return { pages, sha256: typeof v.file_sha256 === 'string' ? v.file_sha256 : null };
}

// The steps a syllabus version goes through, as shown to the HOD, and the index of the current one.
export const SYLLABUS_STEPS = ['Review and correct the content', 'Confirm it matches the official syllabus', 'Submit for approval', 'Approve to make it active'];
export const syllabusStepIndex = (status) => ({ DRAFT: 0, TEACHER_VERIFIED: 2, HOD_REVIEW: 3, ACTIVE: 4, SUPERSEDED: 4 }[status] ?? -1);

// Change types of a syllabus activation and how they read.
export const CHANGE_LABEL = { ADDED: 'added', REMOVED: 'removed', MODIFIED: 'changed', RENAMED: 'renamed', POTENTIAL_MAPPING: 'possible match' };
export const ENTITY_LABEL = { unit: 'Unit', topic: 'Topic', subtopic: 'Subtopic', course_outcome: 'CO' };

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// The unit / topic / subtopic ids of a stored choice within a tree: ids first, else titles (a question saved before
// the selects existed). A title that names more than one topic is not guessed. Empty ids when nothing matches.
export function locateInTree(tree, { topicId = null, topic = null, subtopicId = null, subtopic = null } = {}) {
  const topics = (tree?.units || []).flatMap((u) => u.topics.map((t) => ({ ...t, unitId: u.id })));
  let t = topicId ? topics.find((x) => x.id === topicId) : null;
  if (!t && topic) {
    const hits = topics.filter((x) => norm(x.title) === norm(topic));
    if (hits.length === 1) [t] = hits;
  }
  if (!t) return { unitId: '', topicId: '', subtopicId: '' };
  const s = (subtopicId && t.subtopics.find((x) => x.id === subtopicId)) || (subtopic && t.subtopics.find((x) => norm(x.title) === norm(subtopic))) || null;
  return { unitId: t.unitId, topicId: t.id, subtopicId: s?.id || '' };
}

// Loads a syllabus tree (path: one of the two tree endpoints, or null for none). Re-loads when the path changes.
export function useSyllabusTree(token, path) {
  const [state, setState] = useState({ tree: null, error: null, path: null });
  useEffect(() => {
    if (!path) return undefined;
    let live = true;
    api.get(path, token)
      .then((tree) => { if (live) setState({ tree, error: null, path }); })
      .catch((e) => { if (live) setState({ tree: null, error: e.message, path }); });
    return () => { live = false; };
  }, [token, path]);
  return state.path === path && path ? state : { tree: null, error: null, path };
}
