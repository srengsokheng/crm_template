import { useState, type ReactNode } from 'react';
import { Inbox, Plus, Trash2 } from 'lucide-react';
import { Avatar, Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, Segmented, Select, Skeleton, Spinner, Textarea } from '../../components/ui/primitives.tsx';
import { RadioGroup, Switch, Tabs } from '../../components/ui/controls.tsx';
import { Dialog, Drawer, Menu } from '../../components/ui/overlays.tsx';
import { DataTable, Pagination, type Column } from '../../components/ui/DataTable.tsx';
import { StageBadge } from '../../components/ui/StageBadge.tsx';

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <Card title={title}>
      {note && <p className="mb-3 text-xs text-muted">{note}</p>}
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </Card>
  );
}

interface Row { id: number; name: string; stage: string; amount: string }
const ROWS: Row[] = [{ id: 1, name: 'Robot arms', stage: 'Proposal', amount: '$12,000' }, { id: 2, name: 'Umbrella renewal', stage: 'Qualified', amount: '$3,400' }];
const COLS: Column<Row>[] = [
  { key: 'name', header: 'Deal', sortKey: 'name', cell: (r) => r.name },
  { key: 'stage', header: 'Stage', cell: (r) => <StageBadge name={r.stage} color={r.stage === 'Proposal' ? 'violet' : 'sky'} /> },
  { key: 'amount', header: 'Amount', align: 'right', cell: (r) => r.amount },
];

/**
 * Every shared component in its states, in one place (not linked from the menu; open /dev/components). Use it to
 * review visual changes in light and dark, and add new shared components here when you create them.
 */
export function ComponentsPage() {
  const [seg, setSeg] = useState<'board' | 'list'>('board');
  const [tab, setTab] = useState<'open' | 'done' | 'all'>('open');
  const [radio, setRadio] = useState<'skip' | 'update' | 'create'>('skip');
  const [check, setCheck] = useState(true);
  const [sw, setSw] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  return (
    <div className="space-y-4">
      <PageHeader title="Components" subtitle="Shared UI building blocks and their states — see docs/UI-RULES.md" />
      <Section title="Buttons" note="One primary action per area. Destructive actions use danger and confirm.">
        <Button variant="primary" icon={<Plus className="size-4" />}>Primary</Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger" icon={<Trash2 className="size-4" />}>Danger</Button>
        <Button variant="success">Success</Button>
        <Button loading>Saving</Button>
        <Button disabled>Disabled</Button>
        <Button size="sm">Small</Button>
        <IconButton label="Add"><Plus className="size-4" /></IconButton>
        <Menu trigger={<Button>Menu</Button>} items={[{ label: 'Edit', onSelect: () => {} }, { label: 'Delete', danger: true, onSelect: () => {} }]} />
      </Section>
      <Section title="Switching views" note="Tabs switch what a page or card shows; Segmented is a compact either/or in a toolbar. Both move with the arrow keys.">
        <div className="w-full"><Tabs label="Example tabs" value={tab} onChange={setTab}
          items={[{ value: 'open', label: 'Open', badge: <Badge tone="brand">3</Badge> }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }]} /></div>
        <Segmented value={seg} onChange={setSeg} options={[{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }]} />
        <Segmented size="sm" value={seg} onChange={setSeg} options={[{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }]} />
      </Section>
      <Section title="Form fields" note="Every field has a visible label; errors say how to fix them.">
        <div className="grid w-full gap-3 sm:grid-cols-2">
          <Field label="Deal name" required htmlFor="g-name"><Input id="g-name" placeholder="e.g. Acme — 3 robotic arms" /></Field>
          <Field label="Amount" htmlFor="g-amt" error="Enter a number, like 1200.50"><Input id="g-amt" invalid defaultValue="12k" /></Field>
          <Field label="Stage" htmlFor="g-stage" hint="Where the deal is now"><Select id="g-stage"><option>New</option><option>Qualified</option></Select></Field>
          <Field label="Notes" htmlFor="g-notes"><Textarea id="g-notes" rows={2} /></Field>
        </div>
      </Section>
      <Section title="Choices" note="Checkbox: a choice saved with the form. Switch: takes effect at once. RadioGroup: pick one of a few, with hints.">
        <Checkbox checked={check} onChange={setCheck} label="Send a copy to me" />
        <Checkbox checked={false} onChange={() => {}} label="Disabled" disabled />
        <div className="w-full max-w-sm"><Switch checked={sw} onChange={setSw} label="Email reminders" hint="Before, on and after the due date" /></div>
        <div className="w-full max-w-sm"><Switch checked={false} onChange={() => {}} label="Disabled switch" disabled /></div>
        <RadioGroup legend="When a row matches an existing contact" value={radio} onChange={setRadio} options={[
          { value: 'skip', label: 'Skip the row', hint: 'Keep the existing contact as it is.' },
          { value: 'update', label: 'Update the existing contact', hint: 'Empty cells change nothing.' },
          { value: 'create', label: 'Create a new contact anyway', disabled: true, hint: 'Not available here.' },
        ]} />
      </Section>
      <Section title="Badges and avatars">
        {(['slate', 'brand', 'green', 'red', 'amber'] as const).map((t) => <Badge key={t} tone={t}>{t}</Badge>)}
        <StageBadge name="Proposal" color="violet" />
        <Avatar name="Ada Lovelace" /><Avatar size="sm" name="Grace Hopper" /><Avatar size="xs" name="Dara Sok" />
      </Section>
      <Section title="States" note="Every list or board has loading, empty and error states.">
        <div className="w-full space-y-2 sm:w-64"><Skeleton className="h-4" /><Skeleton className="h-4 w-2/3" /></div>
        <Spinner />
        <div className="w-full sm:w-72"><EmptyState icon={<Inbox className="size-5" />} title="No deals yet" description="Create one, or import a file." action={<Button size="sm">New deal</Button>} /></div>
        <div className="w-full sm:w-72"><ErrorState message="Couldn’t load deals." onRetry={() => {}} /></div>
      </Section>
      <Card title="Table with paging" padded={false}>
        <DataTable columns={COLS} rows={ROWS} selected={selected} onSelect={setSelected}
          footer={<Pagination page={1} pageSize={25} total={2} onPage={() => {}} />} />
      </Card>
      <Section title="Overlays" note="Dialogs for short decisions; drawers for forms. Escape closes both and focus returns to the button.">
        <Button onClick={() => setDialog(true)}>Open dialog</Button>
        <Button onClick={() => setDrawer(true)}>Open drawer</Button>
      </Section>
      <Dialog open={dialog} onOpenChange={setDialog} title="Delete this deal?" description="It goes to the recycle bin for 30 days." size="sm"
        footer={<><Button onClick={() => setDialog(false)}>Cancel</Button><Button variant="danger" onClick={() => setDialog(false)}>Delete</Button></>}>
        <p className="text-sm">Activities linked only to this deal are deleted with it.</p>
      </Dialog>
      <Drawer open={drawer} onOpenChange={setDrawer} title="New deal" footer={<><Button onClick={() => setDrawer(false)}>Cancel</Button><Button variant="primary" onClick={() => setDrawer(false)}>Create deal</Button></>}>
        <Field label="Deal name" htmlFor="g-d-name"><Input id="g-d-name" /></Field>
      </Drawer>
    </div>
  );
}
