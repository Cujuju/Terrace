import type { JSX } from 'solid-js';

export function StampIcon(): JSX.Element {
  return (
    <svg class="hud-tool__icon" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="stamp-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a6e08a" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="stamp-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a6a45" />
          <stop offset="1" stop-color="#5a3a22" />
        </linearGradient>
        <linearGradient id="stamp-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6e4a2f" />
          <stop offset="1" stop-color="#3a2415" />
        </linearGradient>
        <linearGradient id="stamp-wallL" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#8f6a4a" />
          <stop offset="1" stop-color="#4a2f1a" />
        </linearGradient>
        <linearGradient id="stamp-wallR" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6a4a30" />
          <stop offset="1" stop-color="#2e1c0f" />
        </linearGradient>
        <linearGradient id="stamp-cap" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#d2f3b6" />
          <stop offset="1" stop-color="#6db463" />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      <polygon points="16,13 28,19 16,25 4,19" fill="url(#stamp-top)" />
      <polygon points="4,19 16,25 16,29 4,23" fill="url(#stamp-left)" />
      <polygon points="28,19 16,25 16,29 28,23" fill="url(#stamp-right)" />
      <ellipse cx="16" cy="19.5" rx="6.4" ry="3.3" fill="#2e5a2e" opacity="0.5" />
      <path
        d="M9.6 18.2v-7.6a6.4 3.3 0 0 0 6.4 3.3v7.6a6.4 3.3 0 0 1-6.4-3.3z"
        fill="url(#stamp-wallL)"
      />
      <path
        d="M22.4 18.2v-7.6a6.4 3.3 0 0 1-6.4 3.3v7.6a6.4 3.3 0 0 0 6.4-3.3z"
        fill="url(#stamp-wallR)"
      />
      <ellipse
        cx="16"
        cy="10.6"
        rx="6.4"
        ry="3.3"
        fill="url(#stamp-cap)"
        stroke="#3f7f3e"
        stroke-width="0.4"
      />
      <path d="M16 3.2l3.2 3.4h-2v2.6h-2.4V6.6h-2z" fill="#f4fff2" opacity="0.9" />
    </svg>
  );
}

export function SmoothIcon(): JSX.Element {
  return (
    <svg class="hud-tool__icon" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="smooth-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a6e08a" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="smooth-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a6a45" />
          <stop offset="1" stop-color="#5a3a22" />
        </linearGradient>
        <linearGradient id="smooth-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6e4a2f" />
          <stop offset="1" stop-color="#3a2415" />
        </linearGradient>
        <radialGradient id="smooth-mound" cx="0.4" cy="0.28" r="0.8">
          <stop offset="0" stop-color="#d6f5bd" />
          <stop offset="0.5" stop-color="#7cc478" />
          <stop offset="1" stop-color="#3f7f3e" />
        </radialGradient>
      </defs>
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      <polygon points="16,13 28,19 16,25 4,19" fill="url(#smooth-top)" />
      <polygon points="4,19 16,25 16,29 4,23" fill="url(#smooth-left)" />
      <polygon points="28,19 16,25 16,29 28,23" fill="url(#smooth-right)" />
      <ellipse cx="16" cy="18.4" rx="9.5" ry="4.6" fill="#2e5a2e" opacity="0.45" />
      <path
        d="M6.5 18.6c1.5-5.8 6-8.4 9.5-8.4s8 2.6 9.5 8.4c-2.5 2.2-6.2 3.2-9.5 3.2s-7-1-9.5-3.2z"
        fill="url(#smooth-mound)"
      />
      <path
        d="M9 15.6c2-2.6 4.6-3.6 7-3.6"
        stroke="#ffffff"
        stroke-width="0.9"
        fill="none"
        opacity="0.7"
        stroke-linecap="round"
      />
      <path
        d="M12.5 19.6c3 .9 5.5 .9 8.2 .1"
        stroke="#ffffff"
        stroke-width="0.7"
        fill="none"
        opacity="0.4"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function DragIcon(): JSX.Element {
  return (
    <svg class="hud-tool__icon" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="drag-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a6e08a" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="drag-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a6a45" />
          <stop offset="1" stop-color="#5a3a22" />
        </linearGradient>
        <linearGradient id="drag-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6e4a2f" />
          <stop offset="1" stop-color="#3a2415" />
        </linearGradient>
        <linearGradient id="drag-cap" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#c8f0a8" />
          <stop offset="1" stop-color="#5faa5a" />
        </linearGradient>
        <linearGradient id="drag-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#8f6a4a" />
          <stop offset="1" stop-color="#4a2f1a" />
        </linearGradient>
        <linearGradient id="drag-arrow" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="1" stop-color="#cfe2ef" />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      <polygon points="16,13 28,19 16,25 4,19" fill="url(#drag-top)" />
      <polygon points="4,19 16,25 16,29 4,23" fill="url(#drag-left)" />
      <polygon points="28,19 16,25 16,29 28,23" fill="url(#drag-right)" />
      <polygon points="8,12.6 16,8.6 24,12.6 16,16.6" fill="url(#drag-cap)" />
      <polygon points="8,12.6 16,16.6 16,21 8,17" fill="url(#drag-wall)" />
      <polygon points="24,12.6 16,16.6 16,21 24,17" fill="#4a3220" />
      <path
        d="M19.5 5.2h6.2V3l4.3 3.6-4.3 3.6V8H19.5z"
        fill="url(#drag-arrow)"
        stroke="#5b6873"
        stroke-width="0.4"
      />
    </svg>
  );
}

export function CarveIcon(): JSX.Element {
  return (
    <svg class="hud-tool__icon" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="carve-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a6e08a" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="carve-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a6a45" />
          <stop offset="1" stop-color="#5a3a22" />
        </linearGradient>
        <linearGradient id="carve-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6e4a2f" />
          <stop offset="1" stop-color="#3a2415" />
        </linearGradient>
        <linearGradient id="carve-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a7050" />
          <stop offset="1" stop-color="#4f3320" />
        </linearGradient>
        <linearGradient id="carve-cap" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#b9e89c" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="carve-ring" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#e2c19a" />
          <stop offset="1" stop-color="#a67c58" />
        </linearGradient>
        <radialGradient id="carve-hole" cx="0.5" cy="0.9" r="0.85">
          <stop offset="0" stop-color="#05070a" />
          <stop offset="0.6" stop-color="#1a1410" />
          <stop offset="1" stop-color="#3a2a1e" />
        </radialGradient>
      </defs>
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      <polygon points="16,13 28,19 16,25 4,19" fill="url(#carve-top)" />
      <polygon points="4,19 16,25 16,29 4,23" fill="url(#carve-left)" />
      <polygon points="28,19 16,25 16,29 28,23" fill="url(#carve-right)" />
      <polygon points="7,10 16,5.5 25,10 16,14.5" fill="url(#carve-cap)" />
      <polygon points="7,10 16,14.5 16,25 7,20.5" fill="url(#carve-face)" />
      <polygon points="25,10 16,14.5 16,25 25,20.5" fill="#3a2415" />
      {
}
      <g transform="skewY(26.565)">
        <path d="M8 17V12.2a3.5 3.5 0 0 1 7 0V17z" fill="url(#carve-ring)" />
        <path d="M9.2 17v-4.8a2.3 2.3 0 0 1 4.6 0V17z" fill="url(#carve-hole)" />
        <path
          d="M8 17V12.2a3.5 3.5 0 0 1 7 0V17"
          stroke="#f4e6d2"
          stroke-width="0.5"
          fill="none"
          opacity="0.7"
        />
      </g>
    </svg>
  );
}

export function SoftIcon(): JSX.Element {
  return (
    <svg class="hud-tool__icon" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="soft-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c8f0a8" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
      </defs>
      <path d="M3 24c6-1 7-15 13-15s7 14 13 15z" fill="url(#soft-fill)" />
      <path
        d="M3 24c6-1 7-15 13-15s7 14 13 15"
        stroke="#f4fff2"
        stroke-width="1.2"
        fill="none"
        stroke-linecap="round"
      />
      <rect x="3" y="24" width="26" height="4" rx="1" fill="#5a3a22" />
    </svg>
  );
}

export function HardIcon(): JSX.Element {
  return (
    <svg class="hud-tool__icon" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="hard-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c8f0a8" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
      </defs>
      <path d="M3 24v-5h5v-5h5V9h6v5h5v5h5v5z" fill="url(#hard-fill)" />
      <path
        d="M3 19h5v-5h5V9h6v5h5v5h5"
        stroke="#f4fff2"
        stroke-width="1.2"
        fill="none"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <rect x="3" y="24" width="26" height="4" rx="1" fill="#5a3a22" />
    </svg>
  );
}

export function RaiseIcon(): JSX.Element {
  return (
    <svg class="hud-tool__icon" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="raise-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a6e08a" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="raise-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a6a45" />
          <stop offset="1" stop-color="#5a3a22" />
        </linearGradient>
        <linearGradient id="raise-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6e4a2f" />
          <stop offset="1" stop-color="#3a2415" />
        </linearGradient>
        <linearGradient id="raise-arrow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#e8ffe0" />
          <stop offset="1" stop-color="#6fbf73" />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      <polygon points="16,13 28,19 16,25 4,19" fill="url(#raise-top)" />
      <polygon points="4,19 16,25 16,29 4,23" fill="url(#raise-left)" />
      <polygon points="28,19 16,25 16,29 28,23" fill="url(#raise-right)" />
      <ellipse cx="16" cy="18.5" rx="6.5" ry="3.2" fill="#2e5a2e" opacity="0.5" />
      <path
        d="M16 3.5l5.5 6h-3.2v6.5h-4.6V9.5h-3.2z"
        fill="url(#raise-arrow)"
        stroke="#2e5a2e"
        stroke-width="0.5"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function LowerIcon(): JSX.Element {
  return (
    <svg class="hud-tool__icon" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lower-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a6e08a" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="lower-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a6a45" />
          <stop offset="1" stop-color="#5a3a22" />
        </linearGradient>
        <linearGradient id="lower-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6e4a2f" />
          <stop offset="1" stop-color="#3a2415" />
        </linearGradient>
        <linearGradient id="lower-arrow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffd9bd" />
          <stop offset="1" stop-color="#d98a5a" />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      <polygon points="16,13 28,19 16,25 4,19" fill="url(#lower-top)" />
      <polygon points="4,19 16,25 16,29 4,23" fill="url(#lower-left)" />
      <polygon points="28,19 16,25 16,29 28,23" fill="url(#lower-right)" />
      <ellipse cx="16" cy="18.5" rx="6.5" ry="3.2" fill="#000" opacity="0.5" />
      <path
        d="M16 16.5l5.5-6h-3.2V4h-4.6v6.5h-3.2z"
        fill="url(#lower-arrow)"
        stroke="#6a3a1a"
        stroke-width="0.5"
        stroke-linejoin="round"
      />
    </svg>
  );
}
