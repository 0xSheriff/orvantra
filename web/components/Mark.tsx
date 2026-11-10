/**
 * The Orvantra mark — a filled ink tile, the serif O (Newsreader, traced to a path so it renders
 * without the font loaded) and one piercing rule with B's overhang. Identical geometry to
 * `app/icon.svg` (the favicon). `tone="paper"` inverts it for dark surfaces.
 */
export function Mark({ size = 24, tone = 'ink', className }: { size?: number; tone?: 'ink' | 'paper'; className?: string }) {
  const ink = tone === 'ink' ? 'var(--ink)' : 'var(--paper)';
  const paper = tone === 'ink' ? 'var(--paper)' : 'var(--ink)';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect x="2.5" y="2.5" width="27" height="27" fill={ink} />
      <line x1="6" y1="16" x2="26" y2="16" stroke={paper} strokeWidth="1.6" />
      <path
        fill={paper}
        d="M16.00 23.99Q14.01 23.99 12.54 23.07Q11.07 22.15 10.26 20.37Q9.45 18.59 9.45 16.00Q9.45 13.41 10.26 11.63Q11.07 9.85 12.54 8.93Q14.01 8.01 16.00 8.01Q17.99 8.01 19.46 8.93Q20.93 9.85 21.74 11.63Q22.55 13.41 22.55 16.00Q22.55 18.59 21.74 20.37Q20.93 22.15 19.46 23.07Q17.99 23.99 16.00 23.99ZM16.00 22.33Q17.35 22.33 18.37 21.70Q19.39 21.07 19.97 19.94Q20.56 18.81 20.56 17.28V14.72Q20.56 13.19 19.97 12.05Q19.39 10.91 18.37 10.29Q17.35 9.67 16.00 9.67Q14.67 9.67 13.64 10.29Q12.61 10.91 12.03 12.05Q11.44 13.19 11.44 14.72V17.28Q11.44 18.81 12.03 19.94Q12.61 21.07 13.64 21.70Q14.67 22.33 16.00 22.33Z"
      />
    </svg>
  );
}
