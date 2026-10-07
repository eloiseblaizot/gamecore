/** Avatar d'un joueur : emoji, image Discord, ou initiale. */
export function Avatar({ name, avatar, size = 48 }: { name: string; avatar: string | null; size?: number }) {
  const style = { width: size, height: size, fontSize: size * 0.55 };
  if (avatar?.startsWith("https://")) {
    return (
      <img className="avatar" src={avatar} alt="" width={size} height={size} referrerPolicy="no-referrer" />
    );
  }
  return (
    <span className="avatar" style={style} aria-hidden>
      {avatar ?? name.slice(0, 1).toUpperCase()}
    </span>
  );
}
