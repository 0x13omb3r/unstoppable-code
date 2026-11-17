import type { ComponentType } from 'react';
import {
  RocketLaunchIcon,
  BugReportIcon,
  CodeIcon,
  Boxes,
  DocumentSearchIcon,
  DataUsageIcon,
  LineChart1Icon,
  ScheduleIcon,
  TimeFliesIcon,
  MailIcon,
  BellIcon,
  LaptopIcon,
  Bot,
  CognitionIcon,
  SparkleIcon,
  EyeIcon,
  ShieldIcon,
  ShieldCheck,
  Lock,
  GlobeIcon,
  Cloud,
  SunIcon,
  MoonIcon,
  StarIcon,
  CameraIcon,
} from '../../icons/AppIcons';

export interface BotIconOption {
  readonly name: string;
  readonly label: string;
  readonly group: string;
  readonly icon: ComponentType<Parameters<typeof RocketLaunchIcon>[0]>;
}

/** Curated manifest Lucide names, not arbitrary executable component names. */
export const BOT_ICON_OPTIONS: readonly BotIconOption[] = [
  { name: 'rocket', label: 'Rocket', group: 'Work', icon: RocketLaunchIcon },
  { name: 'bug', label: 'Bug', group: 'Work', icon: BugReportIcon },
  { name: 'code', label: 'Code', group: 'Work', icon: CodeIcon },
  { name: 'boxes', label: 'Building blocks', group: 'Work', icon: Boxes },
  {
    name: 'file-search',
    label: 'File search',
    group: 'Work',
    icon: DocumentSearchIcon,
  },
  { name: 'chart', label: 'Chart', group: 'Work', icon: DataUsageIcon },
  {
    name: 'line-chart',
    label: 'Line chart',
    group: 'Work',
    icon: LineChart1Icon,
  },
  {
    name: 'calendar-clock',
    label: 'Calendar',
    group: 'Work',
    icon: ScheduleIcon,
  },
  { name: 'clock', label: 'Clock', group: 'Work', icon: TimeFliesIcon },
  { name: 'mail', label: 'Mail', group: 'Work', icon: MailIcon },
  { name: 'bell', label: 'Bell', group: 'Work', icon: BellIcon },
  { name: 'laptop', label: 'Laptop', group: 'Work', icon: LaptopIcon },
  { name: 'bot', label: 'Robot', group: 'Agents and safety', icon: Bot },
  {
    name: 'brain',
    label: 'Brain',
    group: 'Agents and safety',
    icon: CognitionIcon,
  },
  {
    name: 'sparkles',
    label: 'Sparkles',
    group: 'Agents and safety',
    icon: SparkleIcon,
  },
  { name: 'eye', label: 'Eye', group: 'Agents and safety', icon: EyeIcon },
  {
    name: 'shield',
    label: 'Shield',
    group: 'Agents and safety',
    icon: ShieldIcon,
  },
  {
    name: 'shield-check',
    label: 'Shield check',
    group: 'Agents and safety',
    icon: ShieldCheck,
  },
  { name: 'lock', label: 'Lock', group: 'Agents and safety', icon: Lock },
  {
    name: 'globe',
    label: 'Globe',
    group: 'Nature and places',
    icon: GlobeIcon,
  },
  { name: 'cloud', label: 'Cloud', group: 'Nature and places', icon: Cloud },
  { name: 'sun', label: 'Sun', group: 'Nature and places', icon: SunIcon },
  { name: 'moon', label: 'Moon', group: 'Nature and places', icon: MoonIcon },
  { name: 'star', label: 'Star', group: 'Nature and places', icon: StarIcon },
  {
    name: 'camera',
    label: 'Camera',
    group: 'Nature and places',
    icon: CameraIcon,
  },
];
