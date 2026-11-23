export type NavItem = {
  label: string;
  /** The route, or null when the page does not exist yet. */
  href: string | null;
};

/** The five sections of the site. Only Charts has a page so far. */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Map", href: null },
  { label: "Charts", href: "/charts" },
  { label: "Shelf", href: null },
  { label: "Match", href: null },
  { label: "Listen", href: null },
];
