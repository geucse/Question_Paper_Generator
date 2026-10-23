// Question attachments as question content (phase 4a): what the review screens list, which files a paper's
// question snapshot refers to, and the image bytes the PDF embeds.
//
// Papers are rendered from their snapshots (spec §28). Since migration 041 a snapshot records the question's clean
// attachments at generation (id, name, type, hash); a file is shown only while the stored row is still that same
// clean file (same hash, not quarantined). A snapshot made before 041 has no such list: then only files that
// already existed when the paper was generated are referred to (attachments of a question that is no longer
// editable cannot change, migration 038), and they are flagged legacy_reference. Old snapshots are never rewritten.
import fs from 'fs';
import { all } from './db.js';
import { resolveStored } from './attachment-scan.js';
import { PRINTABLE_IMAGE_TYPES } from './question-types.js';

// Clean attachments of question `q` as a JSON list (id, file_name, file_type), for the question-bank review lists.
export const QUESTION_ATTACHMENTS_SQL = `COALESCE((SELECT json_agg(json_build_object('id', a.id, 'file_name', a.file_name, 'file_type', a.file_type) ORDER BY a.created_at, a.id)
    FROM question_attachments a WHERE a.question_id = q.id AND a.scan_status = 'clean'), '[]'::json)`;

const usable = (a) => !!a && a.scan_status === 'clean' && !!a.file_path && !a.file_path.startsWith('quarantine/');

// rows: [{ question_id, metadata_snapshot }] of one paper. Returns Map(question_id -> [{ id, file_name, file_type,
// available, file_path, legacy_reference? }]). file_path is internal: strip it with publicAttachment before replying.
export async function paperQuestionAttachments(paper, rows, db = { all }) {
  const ids = [...new Set(rows.map((r) => r.question_id).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const live = await db.all(`SELECT a.id, a.question_id, a.file_name, a.file_type, a.file_hash, a.file_path, a.scan_status, a.created_at
    FROM question_attachments a WHERE a.question_id = ANY($1::uuid[]) ORDER BY a.created_at, a.id`, [ids]);
  const cutoff = paper.generated_at || paper.created_at || null;
  for (const r of rows) {
    if (!r.question_id) continue;
    const recorded = r.metadata_snapshot?.attachments;
    const list = Array.isArray(recorded)
      ? recorded.map((s) => {
        const a = live.find((x) => x.id === s.id && x.question_id === r.question_id);
        return { id: s.id, file_name: s.file_name, file_type: s.file_type, available: usable(a) && a.file_hash === s.file_hash, file_path: a?.file_path || null };
      })
      : live.filter((a) => a.question_id === r.question_id && cutoff && new Date(a.created_at) <= new Date(cutoff))
        .map((a) => ({ id: a.id, file_name: a.file_name, file_type: a.file_type, available: usable(a), file_path: a.file_path, legacy_reference: true }));
    out.set(r.question_id, list);
  }
  return out;
}

export const publicAttachment = ({ file_path: _internal, ...rest }) => rest;

// The attachments a PDF needs: printable images with their bytes (data = null when the file cannot be read, so the
// PDF says the diagram is missing instead of failing), other files by name only.
export function withImageData(list = []) {
  return list.map((a) => {
    const printable = a.available && PRINTABLE_IMAGE_TYPES.includes(a.file_type);
    let data = null;
    if (printable) { try { data = fs.readFileSync(resolveStored(a.file_path)); } catch { data = null; } }
    return { ...publicAttachment(a), printable, data };
  });
}
