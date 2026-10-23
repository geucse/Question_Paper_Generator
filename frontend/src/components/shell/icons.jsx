// Small inline icons (stroke = currentColor); decorative, so hidden from assistive technology.
const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
export const MenuIcon = () => <svg {...base}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
export const CloseIcon = () => <svg {...base}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const BellIcon = () => <svg {...base}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>;
export const RefreshIcon = () => <svg {...base}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>;
