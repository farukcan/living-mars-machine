import { useEffect } from 'react';
import { Scene } from './render/Scene.tsx';
import { BuildingStudio, type StudioBuildingKind } from './render/BuildingStudio.tsx';
import { startLoop } from './state/loop.ts';
import { useStore } from './state/store.ts';
import { CasualtyAlert, CriticalWarnings, OutageAlert } from './ui/Alerts.tsx';
import { BuildBar } from './ui/BuildBar.tsx';
import { EventToast } from './ui/EventToast.tsx';
import { GameOverOverlay } from './ui/GameOverOverlay.tsx';
import { HoverCard } from './ui/HoverCard.tsx';
import { InspectorPanel } from './ui/InspectorPanel.tsx';
import { DesktopNotice, Onboarding } from './ui/Onboarding.tsx';
import { ProfilerPanel } from './ui/ProfilerPanel.tsx';
import { QuestPanel } from './ui/QuestPanel.tsx';
import { Sparkline } from './ui/Sparkline.tsx';
import { StatusPanel } from './ui/StatusPanel.tsx';
import { TopBar } from './ui/TopBar.tsx';
import { TutorialCard } from './ui/tutorial/TutorialCard.tsx';
import { startTutorialWatcher } from './ui/tutorial/watcher.ts';
import { COLUMN_WIDTH } from './ui/panel.ts';
import { hudLayerStyle, useUiScale } from './ui/uiScale.ts';

export function App() {
  const params = new URLSearchParams(window.location.search);
  const studioBuilding = params.get('building') as StudioBuildingKind | null;
  const uiScale = useUiScale();

  // One rAF chain for the lifetime of the app; the loop owns simulation cadence. The
  // tutorial watcher rides the snapshots that loop publishes, so the two share a lifetime.
  useEffect(() => {
    if (studioBuilding) return;
    const stopLoop = startLoop();
    const stopWatcher = startTutorialWatcher();
    return () => {
      stopWatcher();
      stopLoop();
    };
  }, [studioBuilding]);

  // Escape is the universal "stop what I'm doing": it clears placement, then selection.
  // F3 toggles the frame profiler, following the convention players already know.
  useEffect(() => {
    if (studioBuilding) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F3') {
        // Firefox binds F3 to find-again, which would steal focus from the canvas.
        event.preventDefault();
        useStore.getState().toggleProfiler();
        return;
      }
      if (event.key !== 'Escape') return;
      const store = useStore.getState();
      if (store.interaction.buildMode !== null) store.setBuildMode(null);
      else store.selectBuilding(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [studioBuilding]);

  if (studioBuilding) {
    return <BuildingStudio kind={studioBuilding} />;
  }

  return (
    <div className="relative h-dvh w-dvw overflow-hidden bg-[#1A1626]">
      <Scene />

      {/* The HUD is a stack of full-width rows, not a pile of hand-placed layers: the
          readout strip, a middle band that takes whatever is left, and the build bar.
          Nothing is offset by a hardcoded `top-*`, so a strip that wraps onto a second line
          pushes everything below it down instead of being covered. The whole stack is laid
          out at a reference resolution and scaled as one piece (see uiScale.ts), so a small
          portal iframe shows the same composition as a desktop window. */}
      <div
        className="pointer-events-none absolute left-0 top-0 flex origin-top-left flex-col"
        style={hudLayerStyle(uiScale)}
      >
        <TopBar />

        <div className="flex min-h-0 flex-1 gap-2 p-3">
          {/* Left: what the player opened, with the profiler pinned to the foot. */}
          <div className={`flex min-h-0 shrink-0 flex-col gap-2 ${COLUMN_WIDTH}`}>
            <InspectorPanel />
            <Onboarding />
            <TutorialCard />
            <div className="mt-auto">
              <ProfilerPanel />
            </div>
          </div>

          {/* Alarms take the world's own lane rather than a row above it. They are the one
              part of the HUD that comes and goes mid-run, and as a row they resized the band
              below them — a meteor arriving would drop both side columns down the screen.
              As a third column they are still centred on the viewport, and their height is
              nobody else's business. */}
          <div className="flex min-h-0 flex-1 flex-col items-center gap-2">
            <OutageAlert />
            <CasualtyAlert />
            <CriticalWarnings />
            <EventToast />
          </div>

          {/* Right: how the run is going, what it is aiming at, and the readouts. */}
          <div className={`flex min-h-0 shrink-0 flex-col items-end gap-2 ${COLUMN_WIDTH}`}>
            <StatusPanel />
            <div className="my-auto w-full">
              <QuestPanel />
            </div>
            <div className="pointer-events-auto relative flex min-h-0 w-full flex-col">
              {/* The hover readout floats just above the reserves instead of taking a row,
                  so pointing at a building never resizes the column. */}
              <div className="pointer-events-none absolute bottom-full mb-2 w-full">
                <HoverCard />
              </div>
              <Sparkline />
            </div>
          </div>
        </div>

        <BuildBar />
      </div>

      <DesktopNotice />

      {/* Last, so the ending covers everything. */}
      <GameOverOverlay />
    </div>
  );
}
