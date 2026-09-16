import type { JSX } from 'solid-js';

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
