/** Les quatre réponses : une couleur ET une forme (lisible aussi par les daltoniens). */
export const CHOICE_STYLES = [
  { letter: "A", shape: "▲", name: "triangle", className: "choice-a" },
  { letter: "B", shape: "◆", name: "losange", className: "choice-b" },
  { letter: "C", shape: "●", name: "rond", className: "choice-c" },
  { letter: "D", shape: "■", name: "carré", className: "choice-d" },
] as const;
