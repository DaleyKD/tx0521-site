export interface NavItem {
  label: string;
  /** Omit for a group label that only toggles its children (not a real destination). */
  href?: string;
  /** Opens in a new tab — reserved for genuinely external destinations, not the not-yet-migrated tx0521.org pages. */
  newTab?: boolean;
  children?: NavItem[];
}

export const navigation: NavItem[] = [
  { label: 'Home', href: '/' },
  {
    label: 'About',
    href: '/about/',
    children: [
      { label: 'Our Troop', href: '/about/' },
      {
        label: 'Programs',
        children: [
          { label: 'Woodlands Trail', href: '/about/woodlands-trail/' },
          { label: 'Navigators', href: '/about/navigators/' },
          { label: 'Adventurers', href: '/about/adventurers/' },
        ],
      },
      { label: 'Uniforms', href: 'https://www.tx0521.org/about/uniforms/' },
      { label: 'Join Our Troop', href: '/about/join/' },
    ],
  },
  { label: 'Calendar', href: '/calendar/' },
  { label: 'Shop', href: 'https://shop.traillifeusa.com', newTab: true },
  {
    label: 'Links',
    children: [
      { label: 'The Crossroads Community Church', href: 'https://www.the3c.church', newTab: true },
      { label: 'Trail Life USA', href: 'https://www.traillifeusa.com', newTab: true },
      { label: 'Member Login', href: 'https://www.traillifeconnect.com/login', newTab: true },
    ],
  },
  { label: 'Contact', href: '/contact/' },
];
