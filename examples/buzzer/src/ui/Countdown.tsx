import { useCountdown } from "@gamecore/react";

/** Chrono circulaire, calé sur l'heure du serveur. */
export function Countdown({
  deadline,
  duration,
  size = 120,
}: {
  deadline: number;
  duration: number;
  size?: number;
}) {
  const left = useCountdown(deadline);
  const seconds = Math.ceil(left / 1000);
  const ratio = duration > 0 ? left / duration : 0;
  const r = 45;
  const circumference = 2 * Math.PI * r;
  return (
    <div className={`countdown${seconds <= 5 ? " is-urgent" : ""}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle className="countdown-track" cx="50" cy="50" r={r} />
        <circle
          className="countdown-bar"
          cx="50"
          cy="50"
          r={r}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      <span className="countdown-value" role="timer" aria-label={`${seconds} secondes restantes`}>
        {seconds}
      </span>
    </div>
  );
}
