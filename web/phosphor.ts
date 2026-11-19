// The app's line icons are Phosphor (@phosphor-icons/react), in its Light weight. The rest of the app asks for an icon by
// the short name below (icon('play'), <Icon name="play" />); this is the one place that says which Phosphor icon it is.
// Each icon is imported from its own file: the package's index pulls in all 1,500 of them, which slows every test.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrowBendUpLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowBendUpLeft';
import { FloppyDiskIcon } from '@phosphor-icons/react/dist/csr/FloppyDisk';
import { ApertureIcon } from '@phosphor-icons/react/dist/csr/Aperture';
import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { FolderPlusIcon } from '@phosphor-icons/react/dist/csr/FolderPlus';
import { KeyboardIcon } from '@phosphor-icons/react/dist/csr/Keyboard';
import { KanbanIcon } from '@phosphor-icons/react/dist/csr/Kanban';
import { TagIcon } from '@phosphor-icons/react/dist/csr/Tag';
import { SmileyIcon } from '@phosphor-icons/react/dist/csr/Smiley';
import { CircleDashedIcon } from '@phosphor-icons/react/dist/csr/CircleDashed';
import { CircleHalfIcon } from '@phosphor-icons/react/dist/csr/CircleHalf';
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { UserIcon } from '@phosphor-icons/react/dist/csr/User';
import { MinusIcon } from '@phosphor-icons/react/dist/csr/Minus';
import { LinkSimpleIcon } from '@phosphor-icons/react/dist/csr/LinkSimple';
import { CaretDoubleUpIcon } from '@phosphor-icons/react/dist/csr/CaretDoubleUp';
import { CaretUpIcon } from '@phosphor-icons/react/dist/csr/CaretUp';
import { GithubLogoIcon } from '@phosphor-icons/react/dist/csr/GithubLogo';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { ArrowsOutCardinalIcon } from '@phosphor-icons/react/dist/csr/ArrowsOutCardinal';
import { ArrowsOutSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { AtIcon } from '@phosphor-icons/react/dist/csr/At';
import { AtomIcon } from '@phosphor-icons/react/dist/csr/Atom';
import { BellIcon } from '@phosphor-icons/react/dist/csr/Bell';
import { BoneIcon } from '@phosphor-icons/react/dist/csr/Bone';
import { BookmarkSimpleIcon } from '@phosphor-icons/react/dist/csr/BookmarkSimple';
import { BooksIcon } from '@phosphor-icons/react/dist/csr/Books';
import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { BroadcastIcon } from '@phosphor-icons/react/dist/csr/Broadcast';
import { BrowserIcon } from '@phosphor-icons/react/dist/csr/Browser';
import { CalendarBlankIcon } from '@phosphor-icons/react/dist/csr/CalendarBlank';
import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { CameraRotateIcon } from '@phosphor-icons/react/dist/csr/CameraRotate';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { ChatCircleIcon } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { ChatTextIcon } from '@phosphor-icons/react/dist/csr/ChatText';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise';
import { NotePencilIcon } from '@phosphor-icons/react/dist/csr/NotePencil';
import { CodeIcon } from '@phosphor-icons/react/dist/csr/Code';
import { ColumnsIcon } from '@phosphor-icons/react/dist/csr/Columns';
import { CompassToolIcon } from '@phosphor-icons/react/dist/csr/CompassTool';
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
import { CpuIcon } from '@phosphor-icons/react/dist/csr/Cpu';
import { CubeIcon } from '@phosphor-icons/react/dist/csr/Cube';
import { CubeTransparentIcon } from '@phosphor-icons/react/dist/csr/CubeTransparent';
import { CursorClickIcon } from '@phosphor-icons/react/dist/csr/CursorClick';
import { DeviceMobileIcon } from '@phosphor-icons/react/dist/csr/DeviceMobile';
import { DotsSixVerticalIcon } from '@phosphor-icons/react/dist/csr/DotsSixVertical';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { EnvelopeSimpleIcon } from '@phosphor-icons/react/dist/csr/EnvelopeSimple';
import { ExportIcon } from '@phosphor-icons/react/dist/csr/Export';
import { FadersIcon } from '@phosphor-icons/react/dist/csr/Faders';
import { FileIcon } from '@phosphor-icons/react/dist/csr/File';
import { FilePdfIcon } from '@phosphor-icons/react/dist/csr/FilePdf';
import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { FilmSlateIcon } from '@phosphor-icons/react/dist/csr/FilmSlate';
import { FilmStripIcon } from '@phosphor-icons/react/dist/csr/FilmStrip';
import { FlaskIcon } from '@phosphor-icons/react/dist/csr/Flask';
import { FolderOpenIcon } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple';
import { GaugeIcon } from '@phosphor-icons/react/dist/csr/Gauge';
import { GearIcon } from '@phosphor-icons/react/dist/csr/Gear';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GlobeIcon } from '@phosphor-icons/react/dist/csr/Globe';
import { WebhooksLogoIcon } from '@phosphor-icons/react/dist/csr/WebhooksLogo';
import { HandIcon } from '@phosphor-icons/react/dist/csr/Hand';
import { HardDrivesIcon } from '@phosphor-icons/react/dist/csr/HardDrives';
import { HouseIcon } from '@phosphor-icons/react/dist/csr/House';
import { ImageIcon } from '@phosphor-icons/react/dist/csr/Image';
import { ImageSquareIcon } from '@phosphor-icons/react/dist/csr/ImageSquare';
import { IntersectIcon } from '@phosphor-icons/react/dist/csr/Intersect';
import { KeyIcon } from '@phosphor-icons/react/dist/csr/Key';
import { LightningIcon } from '@phosphor-icons/react/dist/csr/Lightning';
import { ListChecksIcon } from '@phosphor-icons/react/dist/csr/ListChecks';
import { MagicWandIcon } from '@phosphor-icons/react/dist/csr/MagicWand';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { MagnifyingGlassMinusIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlassMinus';
import { MagnifyingGlassPlusIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlassPlus';
import { MaskHappyIcon } from '@phosphor-icons/react/dist/csr/MaskHappy';
import { MonitorIcon } from '@phosphor-icons/react/dist/csr/Monitor';
import { MusicNotesIcon } from '@phosphor-icons/react/dist/csr/MusicNotes';
import { NewspaperIcon } from '@phosphor-icons/react/dist/csr/Newspaper';
import { NotepadIcon } from '@phosphor-icons/react/dist/csr/Notepad';
import { PaintBrushIcon } from '@phosphor-icons/react/dist/csr/PaintBrush';
import { PaintBucketIcon } from '@phosphor-icons/react/dist/csr/PaintBucket';
import { PaletteIcon } from '@phosphor-icons/react/dist/csr/Palette';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/csr/PaperPlaneTilt';
import { PaperclipIcon } from '@phosphor-icons/react/dist/csr/Paperclip';
import { PauseCircleIcon } from '@phosphor-icons/react/dist/csr/PauseCircle';
import { PenNibIcon } from '@phosphor-icons/react/dist/csr/PenNib';
import { PencilLineIcon } from '@phosphor-icons/react/dist/csr/PencilLine';
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlanetIcon } from '@phosphor-icons/react/dist/csr/Planet';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { PlugsIcon } from '@phosphor-icons/react/dist/csr/Plugs';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { PolygonIcon } from '@phosphor-icons/react/dist/csr/Polygon';
import { PrinterIcon } from '@phosphor-icons/react/dist/csr/Printer';
import { ProhibitIcon } from '@phosphor-icons/react/dist/csr/Prohibit';
import { PuzzlePieceIcon } from '@phosphor-icons/react/dist/csr/PuzzlePiece';
import { RepeatIcon } from '@phosphor-icons/react/dist/csr/Repeat';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { RocketIcon } from '@phosphor-icons/react/dist/csr/Rocket';
import { RulerIcon } from '@phosphor-icons/react/dist/csr/Ruler';
import { ScissorsIcon } from '@phosphor-icons/react/dist/csr/Scissors';
import { ShapesIcon } from '@phosphor-icons/react/dist/csr/Shapes';
import { ShareNetworkIcon } from '@phosphor-icons/react/dist/csr/ShareNetwork';
import { ShieldCheckIcon } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { SpiralIcon } from '@phosphor-icons/react/dist/csr/Spiral';
import { SquareIcon } from '@phosphor-icons/react/dist/csr/Square';
import { SquaresFourIcon } from '@phosphor-icons/react/dist/csr/SquaresFour';
import { StackIcon } from '@phosphor-icons/react/dist/csr/Stack';
import { StarIcon } from '@phosphor-icons/react/dist/csr/Star';
import { StorefrontIcon } from '@phosphor-icons/react/dist/csr/Storefront';
import { SunDimIcon } from '@phosphor-icons/react/dist/csr/SunDim';
import { SunHorizonIcon } from '@phosphor-icons/react/dist/csr/SunHorizon';
import { SwapIcon } from '@phosphor-icons/react/dist/csr/Swap';
import { TargetIcon } from '@phosphor-icons/react/dist/csr/Target';
import { TerminalWindowIcon } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash';
import { TrayArrowUpIcon } from '@phosphor-icons/react/dist/csr/TrayArrowUp';
import { TreeStructureIcon } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { TriangleIcon } from '@phosphor-icons/react/dist/csr/Triangle';
import { UploadSimpleIcon } from '@phosphor-icons/react/dist/csr/UploadSimple';
import { UserPlusIcon } from '@phosphor-icons/react/dist/csr/UserPlus';
import { UsersIcon } from '@phosphor-icons/react/dist/csr/Users';
import { VideoCameraIcon } from '@phosphor-icons/react/dist/csr/VideoCamera';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { WaveformIcon } from '@phosphor-icons/react/dist/csr/Waveform';
import { WrenchIcon } from '@phosphor-icons/react/dist/csr/Wrench';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { MicrosoftWordLogoIcon } from '@phosphor-icons/react/dist/csr/MicrosoftWordLogo';
import { MicrosoftExcelLogoIcon } from '@phosphor-icons/react/dist/csr/MicrosoftExcelLogo';
import { MicrosoftPowerpointLogoIcon } from '@phosphor-icons/react/dist/csr/MicrosoftPowerpointLogo';
import { ChartLineUpIcon } from '@phosphor-icons/react/dist/csr/ChartLineUp';
import { BugIcon } from '@phosphor-icons/react/dist/csr/Bug';
import { TestTubeIcon } from '@phosphor-icons/react/dist/csr/TestTube';
import { GitDiffIcon } from '@phosphor-icons/react/dist/csr/GitDiff';
import { ScalesIcon } from '@phosphor-icons/react/dist/csr/Scales';
import { FireIcon } from '@phosphor-icons/react/dist/csr/Fire';
import { QuotesIcon } from '@phosphor-icons/react/dist/csr/Quotes';
import { GraduationCapIcon } from '@phosphor-icons/react/dist/csr/GraduationCap';
import { BookOpenTextIcon } from '@phosphor-icons/react/dist/csr/BookOpenText';
import { CalendarCheckIcon } from '@phosphor-icons/react/dist/csr/CalendarCheck';
import { BracketsCurlyIcon } from '@phosphor-icons/react/dist/csr/BracketsCurly';
import { CalculatorIcon } from '@phosphor-icons/react/dist/csr/Calculator';
import { ListMagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/ListMagnifyingGlass';
import { FeatherIcon } from '@phosphor-icons/react/dist/csr/Feather';
import { LightbulbIcon } from '@phosphor-icons/react/dist/csr/Lightbulb';
import { ArrowsSplitIcon } from '@phosphor-icons/react/dist/csr/ArrowsSplit';
import { StairsIcon } from '@phosphor-icons/react/dist/csr/Stairs';
import { MicroscopeIcon } from '@phosphor-icons/react/dist/csr/Microscope';
import { SealCheckIcon } from '@phosphor-icons/react/dist/csr/SealCheck';
import { BinocularsIcon } from '@phosphor-icons/react/dist/csr/Binoculars';
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
  webhook: WebhooksLogoIcon,
  folder: FolderSimpleIcon,
  'user-plus': UserPlusIcon,
  'arrow-up': ArrowUpIcon,
  'arrow-down': ArrowDownIcon,
  'arrow-left': ArrowLeftIcon,
  'arrow-right': ArrowRightIcon,
  ellipsis: DotsThreeIcon,
  'external-link': ArrowSquareOutIcon,
  'maximize-2': ArrowsOutSimpleIcon,
  radio: BroadcastIcon,
  'rotate-ccw': ArrowCounterClockwiseIcon,
  'circle-check': CheckCircleIcon,
  'circle-x': XCircleIcon,
  clock: ClockIcon,
  calendar: CalendarBlankIcon,
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
  'folder-plus': FolderPlusIcon,
  'github-logo': GithubLogoIcon,
  keyboard: KeyboardIcon,
  kanban: KanbanIcon,
  tag: TagIcon,
  smiley: SmileyIcon,
  'circle-dashed': CircleDashedIcon,
  'circle-half': CircleHalfIcon,
  eye: EyeIcon,
  user: UserIcon,
  minus: MinusIcon,
  link: LinkSimpleIcon,
  'chevrons-up': CaretDoubleUpIcon,
  'chevron-up': CaretUpIcon,
  'rotate-cw': ArrowClockwiseIcon,
  'chevron-right': CaretRightIcon,
  rocket: RocketIcon,
  puzzle: PuzzlePieceIcon,
  copy: CopyIcon,
  save: FloppyDiskIcon,
  reply: ArrowBendUpLeftIcon,
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
  // a new chat
  'square-pen': NotePencilIcon,
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
  ruler: RulerIcon,
  'paint-brush': PaintBrushIcon,
  flask: FlaskIcon,
  camera: CameraIcon,
  shapes: ShapesIcon,
  'mask-happy': MaskHappyIcon,
  bone: BoneIcon,
  'pen-nib': PenNibIcon,
  newspaper: NewspaperIcon,
  aperture: ApertureIcon,
  'sun-dim': SunDimIcon,
  'file-pdf': FilePdfIcon,
  code: CodeIcon,
  notepad: NotepadIcon,
  waveform: WaveformIcon,
  sliders: SlidersHorizontalIcon,
  'sun-horizon': SunHorizonIcon,
  triangle: TriangleIcon,
  'image-square': ImageSquareIcon,
  'magic-wand': MagicWandIcon,
  'film-slate': FilmSlateIcon,
  spiral: SpiralIcon,
  'paint-bucket': PaintBucketIcon,
  'cube-transparent': CubeTransparentIcon,
  'camera-rotate': CameraRotateIcon,
  faders: FadersIcon,
  'music-notes': MusicNotesIcon,
  export: ExportIcon,
  atom: AtomIcon,
  scissors: ScissorsIcon,
  browser: BrowserIcon,
  swap: SwapIcon,
  'compass-tool': CompassToolIcon,
  polygon: PolygonIcon,
  'device-mobile': DeviceMobileIcon,
  printer: PrinterIcon,
  // skills' marks (web/skillicons.ts)
  'microsoft-word': MicrosoftWordLogoIcon,
  'microsoft-excel': MicrosoftExcelLogoIcon,
  'microsoft-powerpoint': MicrosoftPowerpointLogoIcon,
  'chart-line-up': ChartLineUpIcon,
  bug: BugIcon,
  'test-tube': TestTubeIcon,
  'git-diff': GitDiffIcon,
  scales: ScalesIcon,
  fire: FireIcon,
  quotes: QuotesIcon,
  'graduation-cap': GraduationCapIcon,
  'book-open': BookOpenTextIcon,
  'calendar-check': CalendarCheckIcon,
  'brackets-curly': BracketsCurlyIcon,
  calculator: CalculatorIcon,
  'list-magnifying-glass': ListMagnifyingGlassIcon,
  feather: FeatherIcon,
  lightbulb: LightbulbIcon,
  'arrows-split': ArrowsSplitIcon,
  stairs: StairsIcon,
  microscope: MicroscopeIcon,
  'seal-check': SealCheckIcon,
  binoculars: BinocularsIcon,
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
