// @vitest-environment happy-dom
import { GameClient, memoryStore } from "@gamecore/client";
import { localTransport } from "@gamecore/client/local";
import { GameProvider } from "@gamecore/react";
import { GameServer, silentLogger, type ServerModule } from "@gamecore/server";
import type { TrackReference } from "@livekit/components-react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rps } from "../../server/src/__fixtures__/rps.js";
import { LiveKitMedia, LocalMedia, MemberVideo, tilesFrom, useMedia } from "./react.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Module « livekit » factice : compte les demandes et renvoie la réponse choisie. */
function fakeLivekit(answer: () => unknown) {
  const calls = vi.fn();
  const module: ServerModule = {
    name: "livekit",
    handles: ["module"],
    handle: () => {
      calls();
      return answer();
    },
  };
  return { module, calls };
}

async function joined(modules: ServerModule[]) {
  const server = new GameServer({ game: rps, logger: silentLogger, modules });
  const client = new GameClient<typeof rps>({ transport: localTransport(server), storage: memoryStore() });
  await client.create("player", { profile: { name: "Alice" } });
  return client;
}

function Probe() {
  const media = useMedia();
  return (
    <p data-testid="media">
      {media.kind}|{media.error ?? ""}
    </p>
  );
}

describe("LiveKitMedia", () => {
  it("ne demande rien quand la vidéo est désactivée ou le module absent", async () => {
    const { module, calls } = fakeLivekit(() => null);
    const client = await joined([module]);
    render(
      <GameProvider client={client}>
        <LiveKitMedia enabled={false}>
          <Probe />
        </LiveKitMedia>
      </GameProvider>,
    );
    expect(screen.getByTestId("media").textContent).toBe("none|");
    const other = await joined([]);
    render(
      <GameProvider client={other}>
        <LiveKitMedia enabled>
          <Probe />
        </LiveKitMedia>
      </GameProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).not.toHaveBeenCalled();
  });

  it("reste sans média quand le salon refuse la vidéo", async () => {
    const { module, calls } = fakeLivekit(() => null);
    const client = await joined([module]);
    render(
      <GameProvider client={client}>
        <LiveKitMedia enabled>
          <Probe />
        </LiveKitMedia>
      </GameProvider>,
    );
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("media").textContent).toBe("none|");
  });

  it("affiche l'erreur du serveur", async () => {
    const { GameError } = await import("@gamecore/core");
    const { module } = fakeLivekit(() => {
      throw new GameError("RATE_LIMITED", "Trop de demandes vidéo, patiente un peu.");
    });
    const client = await joined([module]);
    render(
      <GameProvider client={client}>
        <LiveKitMedia enabled>
          <Probe />
        </LiveKitMedia>
      </GameProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("media").textContent).toBe("none|Trop de demandes vidéo, patiente un peu."),
    );
  });
});

describe("tilesFrom", () => {
  it("associe à chaque membre sa vidéo et son état", () => {
    const participant = (identity: string, extra = {}) => ({
      identity,
      isSpeaking: false,
      isCameraEnabled: true,
      isMicrophoneEnabled: false,
      isLocal: false,
      ...extra,
    });
    const track = (identity: string, muted = false) =>
      ({
        participant: { identity },
        publication: { isMuted: muted },
        source: "camera",
      }) as unknown as TrackReference;
    const tiles = tilesFrom(
      [
        participant("m_alice", { isSpeaking: true }),
        participant("m_bob", { isCameraEnabled: false, isLocal: true }),
      ],
      [track("m_alice"), track("m_bob", true), { participant: { identity: "m_x" } } as never],
    );
    expect(tiles.m_alice).toMatchObject({ speaking: true, camOff: false, micOff: true, isLocal: false });
    expect(tiles.m_alice?.video).toBeDefined();
    expect(tiles.m_bob).toMatchObject({ camOff: true, isLocal: true });
    expect(tiles.m_bob?.video).toBeUndefined();
    expect(tiles.m_x).toBeUndefined();
  });
});

describe("LocalMedia et MemberVideo", () => {
  it("allume la webcam locale et l'affiche, sinon le remplaçant", async () => {
    const stop = vi.fn();
    const stream = Object.assign(new MediaStream(), { getTracks: () => [{ stop }] });
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    function Controls() {
      const { local } = useMedia();
      return <button onClick={() => local?.toggleCam()}>{local?.camOn ? "Couper" : "Allumer"}</button>;
    }
    const { unmount } = render(
      <LocalMedia memberId="m_moi">
        <MemberVideo memberId="m_moi" fallback={<span>avatar</span>} />
        <Controls />
      </LocalMedia>,
    );
    expect(screen.getByText("avatar")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Allumer")));
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    expect(screen.getByText("Couper")).toBeTruthy();
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("signale une caméra refusée", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) },
    });
    function Controls() {
      const { local, error } = useMedia();
      return <button onClick={() => local?.toggleCam()}>{error ?? "Allumer"}</button>;
    }
    render(
      <LocalMedia memberId="m_moi">
        <Controls />
      </LocalMedia>,
    );
    await act(async () => fireEvent.click(screen.getByText("Allumer")));
    await waitFor(() => expect(screen.getByText("Caméra indisponible ou refusée.")).toBeTruthy());
  });
});
