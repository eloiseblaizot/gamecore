import { useRoute } from "./router.js";
import { Home } from "./screens/Home.js";
import { HostScreen } from "./screens/HostScreen.js";
import { Phone } from "./screens/Phone.js";

export function App() {
  const route = useRoute();
  switch (route.name) {
    case "screen":
      return <HostScreen key={route.code} code={route.code} />;
    case "play":
      return <Phone key={route.code} code={route.code} />;
    default:
      return <Home />;
  }
}
