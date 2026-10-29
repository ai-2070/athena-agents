// The app's line icons are Phosphor (@phosphor-icons/react), in its Light weight. The rest of the app asks for an icon by
// the short name below (icon('play'), <Icon name="play" />); this is the one place that says which Phosphor icon it is.
// Each icon is imported from its own file: the package's index pulls in all 1,500 of them, which slows every test.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ArrowsOutCardinalIcon } from '@phosphor-icons/react/dist/csr/ArrowsOutCardinal';
import { ArrowsOutSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { AtIcon } from '@phosphor-icons/react/dist/csr/At';
import { BellIcon } from '@phosphor-icons/react/dist/csr/Bell';
import { BookmarkSimpleIcon } from '@phosphor-icons/react/dist/csr/BookmarkSimple';
import { BooksIcon } from '@phosphor-icons/react/dist/csr/Books';
import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { BroadcastIcon } from '@phosphor-icons/react/dist/csr/Broadcast';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { ChatCircleIcon } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { ChatTextIcon } from '@phosphor-icons/react/dist/csr/ChatText';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise';
import { ColumnsIcon } from '@phosphor-icons/react/dist/csr/Columns';
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
import { CpuIcon } from '@phosphor-icons/react/dist/csr/Cpu';
import { CubeIcon } from '@phosphor-icons/react/dist/csr/Cube';
import { CursorClickIcon } from '@phosphor-icons/react/dist/csr/CursorClick';
import { DotsSixVerticalIcon } from '@phosphor-icons/react/dist/csr/DotsSixVertical';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { EnvelopeSimpleIcon } from '@phosphor-icons/react/dist/csr/EnvelopeSimple';
import { FileIcon } from '@phosphor-icons/react/dist/csr/File';
import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { FilmStripIcon } from '@phosphor-icons/react/dist/csr/FilmStrip';
import { FolderOpenIcon } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple';
import { GaugeIcon } from '@phosphor-icons/react/dist/csr/Gauge';
import { GearIcon } from '@phosphor-icons/react/dist/csr/Gear';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GlobeIcon } from '@phosphor-icons/react/dist/csr/Globe';
import { HandIcon } from '@phosphor-icons/react/dist/csr/Hand';
import { HardDrivesIcon } from '@phosphor-icons/react/dist/csr/HardDrives';
import { HouseIcon } from '@phosphor-icons/react/dist/csr/House';
import { ImageIcon } from '@phosphor-icons/react/dist/csr/Image';
import { IntersectIcon } from '@phosphor-icons/react/dist/csr/Intersect';
import { KeyIcon } from '@phosphor-icons/react/dist/csr/Key';
import { LightningIcon } from '@phosphor-icons/react/dist/csr/Lightning';
import { ListChecksIcon } from '@phosphor-icons/react/dist/csr/ListChecks';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { MagnifyingGlassMinusIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlassMinus';
import { MagnifyingGlassPlusIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlassPlus';
import { MonitorIcon } from '@phosphor-icons/react/dist/csr/Monitor';
import { PaletteIcon } from '@phosphor-icons/react/dist/csr/Palette';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/csr/PaperPlaneTilt';
import { PaperclipIcon } from '@phosphor-icons/react/dist/csr/Paperclip';
import { PauseCircleIcon } from '@phosphor-icons/react/dist/csr/PauseCircle';
import { PencilLineIcon } from '@phosphor-icons/react/dist/csr/PencilLine';
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlanetIcon } from '@phosphor-icons/react/dist/csr/Planet';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { PlugsIcon } from '@phosphor-icons/react/dist/csr/Plugs';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { ProhibitIcon } from '@phosphor-icons/react/dist/csr/Prohibit';
import { PuzzlePieceIcon } from '@phosphor-icons/react/dist/csr/PuzzlePiece';
import { RepeatIcon } from '@phosphor-icons/react/dist/csr/Repeat';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { RocketIcon } from '@phosphor-icons/react/dist/csr/Rocket';
import { ShareNetworkIcon } from '@phosphor-icons/react/dist/csr/ShareNetwork';
import { ShieldCheckIcon } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { SquareIcon } from '@phosphor-icons/react/dist/csr/Square';
import { SquaresFourIcon } from '@phosphor-icons/react/dist/csr/SquaresFour';
import { StackIcon } from '@phosphor-icons/react/dist/csr/Stack';
import { StarIcon } from '@phosphor-icons/react/dist/csr/Star';
import { StorefrontIcon } from '@phosphor-icons/react/dist/csr/Storefront';
import { TargetIcon } from '@phosphor-icons/react/dist/csr/Target';
import { TerminalWindowIcon } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash';
import { TrayArrowUpIcon } from '@phosphor-icons/react/dist/csr/TrayArrowUp';
import { TreeStructureIcon } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { UploadSimpleIcon } from '@phosphor-icons/react/dist/csr/UploadSimple';
import { UserPlusIcon } from '@phosphor-icons/react/dist/csr/UserPlus';
import { UsersIcon } from '@phosphor-icons/react/dist/csr/Users';
import { VideoCameraIcon } from '@phosphor-icons/react/dist/csr/VideoCamera';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { WrenchIcon } from '@phosphor-icons/react/dist/csr/Wrench';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

/** Our short icon names → the Phosphor icon. */
export const PHOSPHOR: Record<string, PhosphorIcon> = {
  orbit: PlanetIcon,
  bot: RobotIcon,
  users: UsersIcon,
  'library-big': BooksIcon,
  settings: GearIcon,
  plus: PlusIcon,
  play: PlayIcon,
  square: SquareIcon,
  'trash-2': TrashIcon,
  pencil: PencilSimpleIcon,
  'message-square': ChatTextIcon,
  'message-circle': ChatCircleIcon,
  terminal: TerminalWindowIcon,
  x: XIcon,
  'chevron-down': CaretDownIcon,
  sparkles: SparkleIcon,
  send: PaperPlaneTiltIcon,
  'git-branch': GitBranchIcon,
  workflow: TreeStructureIcon,
  zap: LightningIcon,
  layers: StackIcon,
  plug: PlugsIcon,
  cpu: CpuIcon,
  image: ImageIcon,
  video: VideoCameraIcon,
  mail: EnvelopeSimpleIcon,
  search: MagnifyingGlassIcon,
  box: CubeIcon,
  check: CheckIcon,
  'triangle-alert': WarningIcon,
  'zoom-in': MagnifyingGlassPlusIcon,
  'zoom-out': MagnifyingGlassMinusIcon,
  house: HouseIcon,
  move: ArrowsOutCardinalIcon,
  hand: HandIcon,
  bell: BellIcon,
  network: ShareNetworkIcon,
  brain: BrainIcon,
  wrench: WrenchIcon,
  globe: GlobeIcon,
  folder: FolderSimpleIcon,
  'user-plus': UserPlusIcon,
  'arrow-up': ArrowUpIcon,
  'arrow-down': ArrowDownIcon,
  ellipsis: DotsThreeIcon,
  'external-link': ArrowSquareOutIcon,
  'maximize-2': ArrowsOutSimpleIcon,
  radio: BroadcastIcon,
  'rotate-ccw': ArrowCounterClockwiseIcon,
  'circle-check': CheckCircleIcon,
  'circle-x': XCircleIcon,
  clock: ClockIcon,
  'shield-check': ShieldCheckIcon,
  'key-round': KeyIcon,
  server: HardDrivesIcon,
  monitor: MonitorIcon,
  film: FilmStripIcon,
  palette: PaletteIcon,
  'pen-line': PencilLineIcon,
  'list-checks': ListChecksIcon,
  'circle-pause': PauseCircleIcon,
  'grip-vertical': DotsSixVerticalIcon,
  'mouse-pointer-click': CursorClickIcon,
  store: StorefrontIcon,
  'file-text': FileTextIcon,
  'folder-open': FolderOpenIcon,
  'rotate-cw': ArrowClockwiseIcon,
  'chevron-right': CaretRightIcon,
  rocket: RocketIcon,
  puzzle: PuzzlePieceIcon,
  copy: CopyIcon,
  'bookmark-plus': BookmarkSimpleIcon,
  download: DownloadSimpleIcon,
  repeat: RepeatIcon,
  'at-sign': AtIcon,
  paperclip: PaperclipIcon,
  file: FileIcon,
  'folder-up': FolderSimpleIcon,
  upload: UploadSimpleIcon,
  archive: ArchiveIcon,
  history: ClockCounterClockwiseIcon,
  'archive-restore': TrayArrowUpIcon,
  star: StarIcon,
  gauge: GaugeIcon,
  target: TargetIcon,
  slash: ProhibitIcon,
  'layout-panel-left': SidebarSimpleIcon,
  'panel-left': SidebarSimpleIcon,
  'panel-right': SidebarSimpleIcon,
  'columns-2': ColumnsIcon,
  'layout-grid': SquaresFourIcon,
  combine: IntersectIcon,
};

/** The Phosphor icon for a name; an unknown (or inherited, like "constructor") name is the box. */
export const phosphorFor = (name: string): PhosphorIcon => (Object.hasOwn(PHOSPHOR, name) ? PHOSPHOR[name]! : CubeIcon);

const markup = new Map<string, string>();
/** What goes inside an <svg viewBox="0 0 256 256"> for the icon, for the plain-DOM icon() (React draws the component itself). */
export function phosphorMarkup(name: string): string {
  const key = Object.hasOwn(PHOSPHOR, name) ? name : 'box';
  let m = markup.get(key);
  if (m === undefined) {
    const svg = renderToStaticMarkup(createElement(phosphorFor(key), { weight: 'light' }));
    m = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));
    markup.set(key, m);
  }
  return m;
}
