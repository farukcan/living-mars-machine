import { useEffect, useState } from 'react';
import logoLockup from '../../media/logo-lockup.svg';
import { useStore } from '../state/store.ts';

/**
 * A one-time orientation card.
 *
 * The colony already runs on first load, so this does not teach controls — it names the
 * one thing a viewer would otherwise have to infer: that the numbers are a simulation, and
 * that the night is what makes it interesting. It dismisses on the first real interaction
 * so nobody has to read it.
 */

const STORAGE_KEY = 'living-machine.onboarding.seen';

/**
 * Backs the stored flag for the rest of the session.
 *
 * Without it a blocked localStorage makes this card and the tutorial watcher disagree: the
 * card hides on its own state while the watcher keeps reading "still up" out of storage and
 * stays silent for the whole run.
 */
let dismissedThisSession = false;

function alreadySeen(): boolean {
  if (dismissedThisSession) return true;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function remember(): void {
  dismissedThisSession = true;
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // A blocked storage is not worth interrupting anyone over.
  }
}

/**
 * Whether the card is still up, answered without rendering it.
 *
 * The tutorial watcher has to stay quiet while this card owns the left column, and it runs
 * outside React. `remember()` writes localStorage before the local `dismissed` state flips,
 * so storage is the source of truth here and the two answers cannot disagree.
 */
export function onboardingVisible(): boolean {
  const { interaction } = useStore.getState();
  const interacted = interaction.buildMode !== null || interaction.selectedBuildingId !== null;
  return !alreadySeen() && !interacted;
}

export function Onboarding() {
  const [dismissed, setDismissed] = useState(alreadySeen);
  const buildMode = useStore((state) => state.interaction.buildMode);
  const selectedBuildingId = useStore((state) => state.interaction.selectedBuildingId);

  // Any real interaction means the card has served its purpose. Derived during render
  // rather than pushed through an effect: a setState inside an effect just to mirror
  // props back into state is a cascading render for no reason.
  const interacted = buildMode !== null || selectedBuildingId !== null;
  const visible = !dismissed && !interacted;

  const dismiss = () => {
    remember();
    setDismissed(true);
  };

  // The effect only writes to the external system, which is what effects are for.
  useEffect(() => {
    if (interacted) remember();
  }, [interacted]);

  if (!visible) return null;

  return (
    // Capped at the column and scrolled like the inspector, so in a short window it never
    // paints over the build bar.
    <div className="pointer-events-auto max-h-full w-full overflow-y-auto rounded-lg border border-[#4FC3F7]/30 bg-black/55 p-3 shadow-lg shadow-black/40 backdrop-blur-sm">
      <div className="flex items-start gap-2">
        {/* The tagline-free lockup: at this width the tagline would only be texture. */}
        <img src={logoLockup} alt="Living Mars Machine" className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={dismiss}
          className="-mr-1 rounded px-1.5 text-white/40 hover:bg-white/10 hover:text-white/80"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-white/60">
        A working Mars colony, already running. Power, water, oxygen, food and heat are solved every
        tick by a priority allocator.
      </p>
      <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-white/50">
        <li>
          <span className="text-white/75">Click a building</span> to see what it makes, what it
          costs, and whether it is being throttled.
        </li>
        <li>
          <span className="text-white/75">Run to nightfall</span> at 16× — solar output hits zero
          and the allocator starts shedding load.
        </li>
        <li>
          <span className="text-white/75">Build</span> from the bar below; extractors need the
          deposit they mine.
        </li>
      </ul>
      <button
        type="button"
        onClick={dismiss}
        className="mt-2.5 w-full rounded border border-white/15 bg-white/5 px-2 py-1.5 text-[11px] text-white/70 hover:bg-white/10"
      >
        Got it
      </button>
    </div>
  );
}

/** Small-screen advisory: the HUD assumes a desktop-sized viewport. */
export function DesktopNotice() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 mx-auto w-64 -translate-y-1/2 rounded-md border border-white/15 bg-black/70 p-3 text-center text-[11px] text-white/70 md:hidden">
      This colony is built for a desktop-sized screen. It runs here, but the HUD will be cramped.
    </div>
  );
}
