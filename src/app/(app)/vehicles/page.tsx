import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "Trucks" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"truck"}
      title={"Trucks"}
      phase={"Phase 3"}
      summary={"Each truck carries its own inventory."}
      capabilities={[
        "Truck number, plate, assigned runner and status",
        "Live stock on every vehicle, separate from the warehouse",
        "Load and unload history",
      ]}
    />
  )
}
