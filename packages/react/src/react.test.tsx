// @vitest-environment happy-dom
import { GameClient, memoryStore } from "@gamecore/client";
import { localTransport } from "@gamecore/client/local";
import { GameServer, controllerModule, silentLogger } from "@gamecore/server";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rps } from "../../server/src/__fixtures__/rps.js";
import { GameProvider } from "./context.js";
import { ControllerButton, Joystick, toVector } from "./controller.js";
import { useControllerInput, useCountdown, useGame, useIsHost, useMe, useRoom } from "./hooks.js";
import { JoinQrCode, joinUrl, qrPath } from "./qr.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const server = new GameServer({ game: rps, logger: silentLogger, modules: [controllerModule()] });
  const make = () =>
    new GameClient<typeof rps>({ transport: localTransport(server), storage: memoryStore() });
  return { server, make };
}

function Lobby() {
  const room = useRoom<typeof rps>();
  const game = useGame<typeof rps>();
  const isHost = useIsHost();
  const me = useMe();
  return (
    <div>
      <p data-testid="status">{room?.status ?? "hors salon"}</p>
      <p data-testid="host">{isHost ? "host" : "invité"}</p>
      <p data-testid="me">{me?.name ?? "écran"}</p>
      <ul>
        {room?.members.map((m) => (
          <li key={m.id}>{m.name}</li>
        ))}
      </ul>
      <p data-testid="choice">{game?.private?.myChoice ?? "-"}</p>
    </div>
  );
}

describe("hooks d'état", () => {
  it("affichent le salon et la partie, et se mettent à jour", async () => {
    const { make } = setup();
    const tv = make();
    const { code } = await tv.create("screen");
    const alice = make();
    render(
      <GameProvider client={alice}>
        <Lobby />
      </GameProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("hors salon");

    await act(() => alice.join(code, { name: "Alice" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("lobby"));
    expect(screen.getByTestId("host").textContent).toBe("host");
    expect(screen.getByTestId("me").textContent).toBe("Alice");

    const bob = make();
    await act(() => bob.join(code, { name: "Bob" }));
    await waitFor(() =>
      expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Alice", "Bob"]),
    );

    await act(() => tv.lobby.start());
    await act(() => alice.act({ type: "choose", choice: "paper" }));
    await waitFor(() => expect(screen.getByTestId("choice").textContent).toBe("paper"));
    expect(screen.getByTestId("status").textContent).toBe("playing");
  });

  it("exigent un GameProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Lobby />)).toThrow(/GameProvider/);
  });

  it("transmettent les entrées de manette à l'écran", async () => {
    const { make } = setup();
    const tv = make();
    const { code } = await tv.create("screen");
    const alice = make();
    const { memberId } = await alice.join(code, { name: "Alice" });
    const onInput = vi.fn();
    function Screen() {
      useControllerInput(onInput);
      return null;
    }
    render(
      <GameProvider client={tv}>
        <Screen />
      </GameProvider>,
    );
    alice.sendInput({ x: 1, y: 0 });
    await waitFor(() => expect(onInput).toHaveBeenCalledWith(memberId, { x: 1, y: 0 }));
  });

  it("calculent un compte à rebours sur l'heure du serveur", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { make } = setup();
    const client = make();
    function Countdown({ deadline }: { deadline: number | null }) {
      return <p data-testid="left">{Math.ceil(useCountdown(deadline) / 1000)}</p>;
    }
    const { rerender } = render(
      <GameProvider client={client}>
        <Countdown deadline={13_000} />
      </GameProvider>,
    );
    expect(screen.getByTestId("left").textContent).toBe("3");
    await act(() => vi.advanceTimersByTimeAsync(1_250));
    expect(screen.getByTestId("left").textContent).toBe("2");
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByTestId("left").textContent).toBe("0");
    rerender(
      <GameProvider client={client}>
        <Countdown deadline={null} />
      </GameProvider>,
    );
    expect(screen.getByTestId("left").textContent).toBe("0");
  });
});

describe("JoinQrCode", () => {
  it("dessine un QR code accessible, sans HTML injecté", () => {
    const url = joinUrl("K7QXPB", { origin: "https://jeu.example" });
    expect(url).toBe("https://jeu.example/play/K7QXPB");
    render(<JoinQrCode url={url} size={150} />);
    const svg = screen.getByRole("img", { name: "QR code pour rejoindre la partie" });
    expect(svg.getAttribute("width")).toBe("150");
    expect(svg.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
  });

  it("est déterministe et dépend de l'URL", () => {
    expect(qrPath("https://a.example/play/AAAA")).toEqual(qrPath("https://a.example/play/AAAA"));
    expect(qrPath("https://a.example/play/AAAA").path).not.toBe(qrPath("https://a.example/play/BBBB").path);
  });

  it("encode le code dans l'URL", () => {
    expect(joinUrl("A B/C", { origin: "https://x.example", path: "/j/" })).toBe(
      "https://x.example/j/A%20B%2FC",
    );
  });
});

describe("ControllerButton", () => {
  it("réagit dès l'appui, au relâchement, et au clavier", () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    render(
      <ControllerButton onPress={onPress} onRelease={onRelease} haptic={0}>
        A
      </ControllerButton>,
    );
    const button = screen.getByRole("button", { name: "A" });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(onRelease).toHaveBeenCalledTimes(2);
  });

  it("ne réagit pas quand il est désactivé", () => {
    const onPress = vi.fn();
    render(
      <ControllerButton onPress={onPress} disabled>
        B
      </ControllerButton>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "B" }), { key: " " });
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("Joystick", () => {
  it("normalise le déplacement, borne au cercle et applique la zone morte", () => {
    expect(toVector(40, 0, 80, 0.12)).toEqual({ x: 0.5, y: 0 });
    expect(toVector(300, 400, 80, 0.12)).toEqual({ x: 0.6, y: 0.8 });
    expect(toVector(5, 5, 80, 0.12)).toEqual({ x: 0, y: 0 });
    expect(toVector(10, 10, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("envoie la position du doigt puis (0, 0) au relâchement", () => {
    const onMove = vi.fn();
    render(<Joystick onMove={onMove} size={160} rateHz={1000} />);
    const pad = screen.getByRole("application", { name: "Joystick" });
    pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 160, height: 160 }) as DOMRect;
    fireEvent.pointerDown(pad, { clientX: 160, clientY: 80, pointerId: 1, buttons: 1 });
    expect(onMove).toHaveBeenLastCalledWith({ x: 1, y: 0 });
    fireEvent.pointerUp(pad, { pointerId: 1 });
    expect(onMove).toHaveBeenLastCalledWith({ x: 0, y: 0 });
  });

  it("limite la fréquence d'envoi sans perdre la dernière position", async () => {
    vi.useFakeTimers();
    const onMove = vi.fn();
    render(<Joystick onMove={onMove} size={160} rateHz={10} />);
    const pad = screen.getByRole("application", { name: "Joystick" });
    pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 160, height: 160 }) as DOMRect;
    fireEvent.pointerDown(pad, { clientX: 160, clientY: 80, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(pad, { clientX: 80, clientY: 160, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(pad, { clientX: 0, clientY: 80, pointerId: 1, buttons: 1 });
    expect(onMove).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove).toHaveBeenLastCalledWith({ x: -1, y: 0 });
  });

  it("se pilote aussi au clavier", () => {
    const onMove = vi.fn();
    render(<Joystick onMove={onMove} />);
    const pad = screen.getByRole("application", { name: "Joystick" });
    fireEvent.keyDown(pad, { key: "ArrowUp" });
    expect(onMove).toHaveBeenLastCalledWith({ x: 0, y: -1 });
    fireEvent.keyDown(pad, { key: "ArrowRight" });
    expect(onMove).toHaveBeenLastCalledWith({ x: 0.707, y: -0.707 });
    fireEvent.keyUp(pad, { key: "ArrowUp" });
    fireEvent.keyUp(pad, { key: "ArrowRight" });
    expect(onMove).toHaveBeenLastCalledWith({ x: 0, y: 0 });
  });
});
