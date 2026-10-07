import { isDiscordActivity } from "@gamecore/discord/client";
import { Suspense } from "react";
import { useRoute } from "./router.js";
import { DiscordActivity } from "./screens/DiscordActivity.js";
import { DiscordCallback } from "./screens/DiscordCallback.js";
import { Home } from "./screens/Home.js";
import { HostScreen } from "./screens/HostScreen.js";
import { Phone } from "./screens/Phone.js";

/** Lancé dans Discord (Activity) ou sur le site ? Ne change pas pendant la vie de la page. */
const inDiscord = isDiscordActivity();

function Pages() {
  const route = useRoute();
  if (inDiscord) return <DiscordActivity />;
  switch (route.name) {
    case "screen":
      return <HostScreen key={route.code} code={route.code} />;
    case "play":
      return <Phone key={route.code} code={route.code} />;
    case "discord-callback":
      return <DiscordCallback />;
    default:
      return <Home />;
  }
}

export function App() {
  return (
    <Suspense
      fallback={
        <main className="page page-center">
          <p className="loading">Chargement…</p>
        </main>
      }
    >
      <Pages />
    </Suspense>
  );
}
