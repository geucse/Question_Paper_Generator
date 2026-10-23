// CO/Bloom override form state (components/BlueprintTools.jsx OverrideFields). The server accepts an override only
// when the exact targets cannot be met and it is the smallest one (backend/src/exam-generator.js planSelection).
export const emptyOverride = () => ({ on: false, co: false, bloom: false, reason: '' });
export const overrideBody = (o) => (o.on ? { relax: [o.co && 'co', o.bloom && 'bloom'].filter(Boolean), reason: o.reason.trim() } : undefined);
export const overrideIncomplete = (o) => o.on && (!(o.co || o.bloom) || o.reason.trim().length < 10);
