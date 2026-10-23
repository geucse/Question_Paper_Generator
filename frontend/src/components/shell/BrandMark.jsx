import { useState } from 'react';
import { BRAND } from '../../brand';

// Institution logo + product name. The logo is drawn only from an approved file (VITE_BRAND_LOGO_URL), at its own
// aspect ratio; until one is supplied, or if it fails to load, the institution name is set as plain text instead.
export default function BrandMark({ product = true }) {
  const [failed, setFailed] = useState(false);
  const showLogo = BRAND.logoUrl && !failed;
  return (
    <div className="ge-brand">
      {showLogo
        ? <img src={BRAND.logoUrl} alt={BRAND.institution} onError={() => setFailed(true)} />
        : <span className="ge-wordmark" data-brand-placeholder="true">{BRAND.institution}</span>}
      {product && <><span className="divider" aria-hidden="true" /><span className="ge-product">{BRAND.product}</span></>}
    </div>
  );
}
