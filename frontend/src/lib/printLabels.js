// How the printed paper numbers a question when it differs from its slot (inside an "attempt any 1" choice the
// paper prints Q2(a) / OR / Q2(b)); the server computes print_label with the PDF's own numbering.
export const labelDiffers = (q) => !!q.print_label && q.print_label !== `Q${q.slot_number}`;
export const printedLabel = (q) => `Q${q.slot_number}${labelDiffers(q) ? ` (printed ${q.print_label})` : ''}`;
