/**
 * @gamecore/react — liaisons React : état du salon et de la partie, évènements, QR code
 * de connexion, primitives de manette.
 */

export { GameProvider, useGameClient } from "./context.js";
export {
  ControllerButton,
  Joystick,
  toVector,
  useWakeLock,
  vibrate,
  type ControllerButtonProps,
  type JoystickProps,
  type JoystickVector,
} from "./controller.js";
export {
  useChat,
  useClientState,
  useConnectionStatus,
  useControllerInput,
  useCountdown,
  useGame,
  useGameEvent,
  useIsHost,
  useMe,
  useRoom,
  useYou,
} from "./hooks.js";
export { JoinQrCode, joinUrl, qrPath, type JoinQrCodeProps } from "./qr.js";
