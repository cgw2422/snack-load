import {
  Boxes, ChartColumn, Factory, House, Menu, Plus, Receipt, Route, Settings, Store, Truck,
  Upload, Users, Wallet,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import type { IconName } from '@/lib/navigation'

const ICONS: Record<IconName, ComponentType<LucideProps>> = {
  home: House,
  route: Route,
  plus: Plus,
  boxes: Boxes,
  menu: Menu,
  store: Store,
  chart: ChartColumn,
  users: Users,
  truck: Truck,
  factory: Factory,
  settings: Settings,
  receipt: Receipt,
  wallet: Wallet,
  upload: Upload,
}

export function NavIcon({ name, ...props }: { name: IconName } & LucideProps) {
  const Icon = ICONS[name]
  return <Icon aria-hidden="true" {...props} />
}
