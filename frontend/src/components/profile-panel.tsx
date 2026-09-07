import { useEffect, useState } from "react"
import {
  Alert,
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from "@mantine/core"
import { ChevronDown, ChevronRight, Download, Plus, Save, Trash2, X } from "lucide-react"

import { api, type ProfileBody } from "@/lib/api"
import { useAction } from "@/hooks/use-action"
import type { ProfileList } from "@/lib/types"

/**
 * A profile is one experiment: which channels it reads, what they are called,
 * and how the module is configured for them.
 *
 * The module's twenty inputs are two different things, and the grid is split
 * accordingly, because which half a channel is in decides what data it makes:
 * 1–10 are triggers, every pulse written to the time-stamp file; 11–20 are
 * scalers, counted and latched once a counting period.
 *
 * Selecting a channel does **not** switch it off in the module. The scaler
 * counts all twenty whatever this says and the runner writes all ten counters
 * to the file; selection decides what the DAQ tab shows. Level and down-scale,
 * in contrast, really are written into the module.
 *
 * ## Two selections, not one
 *
 * `selectedId` is the experiment the whole app is on -- it decides where a run
 * goes, what number it gets, and what the live tables show. Drafting a new
 * profile is a *different* state, held here, because a draft is not something
 * the DAQ tab can run and clearing the app's selection to mean "I am writing a
 * new one" left it with no experiment at all. It also silently did nothing:
 * the app fills an empty selection back in from the first saved profile, so
 * New appeared to be a button that was not wired up.
 */
export function ProfilePanel({
  list,
  selectedId,
  onSelect,
  onChanged,
  locked,
}: {
  list: ProfileList | null
  selectedId: string | null
  onSelect: (id: string) => void
  /** Reload the profile list.  Resolves once the new list is in place, which
   *  is what lets a freshly created profile be selected without the app
   *  correcting it away against a list that predates it. */
  onChanged: () => Promise<unknown>
  /** A run is in progress; its profile is already in the module. */
  locked: boolean
}) {
  const { pending, run } = useAction()

  /** True while writing a profile that does not exist yet. */
  const [drafting, setDrafting] = useState(false)
  const [name, setName] = useState("")
  const [note, setNote] = useState("")
  const [selected, setSelected] = useState<number[]>([])
  const [liveChannels, setLiveChannels] = useState<number[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [inputType, setInputType] = useState<number[]>(Array.from({ length: 20 }, () => 0))
  const [downScale, setDownScale] = useState<number[]>([1, 1, 1])
  const [showSetup, setShowSetup] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importName, setImportName] = useState("")
  const [importText, setImportText] = useState("")
  /** Which profile the form currently holds; null while drafting. */
  const [loadedId, setLoadedId] = useState<string | null>(null)

  const profiles = list?.profiles ?? []
  const channels = list?.channels
  const allChannels = channels?.all ?? Array.from({ length: 20 }, (_, i) => i + 1)
  const triggerChannels = channels?.trigger ?? []
  const downChannels = channels?.down_scale ?? [17, 18, 19]

  const current = profiles.find((each) => each.id === selectedId) ?? null

  // Load the chosen profile into the form. Never while drafting: that would
  // wipe what is being typed the moment the profile list refreshed.
  useEffect(() => {
    if (drafting || selectedId === loadedId) return
    const profile = profiles.find((each) => each.id === selectedId)
    if (!profile) return
    setLoadedId(profile.id)
    setName(profile.name)
    setNote(profile.note)
    setSelected([...profile.selected])
    setLiveChannels([...(profile.live_channels ?? [])])
    setNames({ ...profile.names })
    setInputType([...profile.input_type])
    setDownScale([...profile.down_scale])
  }, [drafting, selectedId, loadedId, profiles])

  function startDraft() {
    setDrafting(true)
    setLoadedId(null)
    setName("")
    setNote("")
    setSelected([])
    setNames({})
    setInputType(list?.defaults.input_type ?? Array.from({ length: 20 }, () => 0))
    setDownScale(list?.defaults.down_scale ?? [1, 1, 1])
  }

  function cancelDraft() {
    setDrafting(false)
    // Force the load effect to put the selected profile back in the form.
    setLoadedId(null)
  }

  const nameTaken =
    drafting && profiles.some((each) => each.name.trim().toLowerCase() === name.trim().toLowerCase())
  const canSave = name.trim().length > 0 && !nameTaken

  const body = (): ProfileBody => ({
    id: drafting ? null : loadedId,
    name,
    selected,
    names,
    input_type: inputType,
    down_scale: downScale,
    note,
    live_channels: liveChannels,
  })

  const save = () =>
    run(
      "save",
      async () => {
        const saved = await api.saveProfile(body())
        setDrafting(false)
        setLoadedId(saved.id)
        await onChanged()
        onSelect(saved.id)
      },
      drafting ? "Profile created, and now selected." : "Profile saved.",
    )

  const toggle = (channel: number) =>
    setSelected((current) =>
      current.includes(channel)
        ? current.filter((each) => each !== channel)
        : [...current, channel].sort((a, b) => a - b),
    )

  const setLevel = (channel: number, level: number) =>
    setInputType((current) => {
      const next = [...current]
      next[channel - 1] = level
      return next
    })

  const toggleLive = (channel: number) =>
    setLiveChannels((current) =>
      current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel].sort((a, b) => a - b),
    )

  const triggers = selected.filter((c) => triggerChannels.includes(c))
  const counters = selected.filter((c) => !triggerChannels.includes(c))

  return (
    <Paper withBorder p="md">
      <Stack gap="md">
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <Group gap="sm" align="baseline">
            <Text fw={600} size="lg">
              Profile
            </Text>
            <Text size="sm" c="dimmed">
              One experiment: the channels it reads, their names, and how the module is set for
              them. Each profile keeps its own runs and its own numbering.
            </Text>
          </Group>
          <Group gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<Plus size={14} />}
              onClick={startDraft}
              disabled={drafting}
            >
              New
            </Button>
            <Button
              variant="default"
              size="xs"
              leftSection={<Download size={14} />}
              onClick={() => setImportOpen(true)}
            >
              Import a setup.txt
            </Button>
          </Group>
        </Group>

        {/* Drafting is a mode, and it says so. Without this the form looked
            identical whether it held a saved profile or a new one, which is
            what made New feel like a button that did nothing. */}
        {drafting ? (
          <Alert color="blue" title="New profile" icon={<Plus size={16} />}>
            <Stack gap={4}>
              <Text size="sm">
                <b>1.</b> Give it a name. <b>2.</b> Tick the channels it reads and set their
                levels. <b>3.</b> Press <b>Create</b>.
              </Text>
              <Text size="xs" c="dimmed">
                Nothing is saved and no directory is made until you press Create. Cancel leaves{" "}
                {current?.name ?? "the current profile"} exactly as it was.
              </Text>
            </Stack>
          </Alert>
        ) : null}

        <Group align="flex-end" wrap="wrap" gap="sm">
          {drafting ? (
            <TextInput
              label="Name"
              placeholder="e.g. KO2520 cosmic"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              error={nameTaken ? "There is already a profile with that name" : undefined}
              data-autofocus
              style={{ flex: 1, minWidth: 220 }}
            />
          ) : (
            <>
              <Select
                label="Editing"
                description="Also the experiment the DAQ tab runs"
                placeholder={profiles.length ? "Pick one" : "None yet — press New"}
                data={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
                value={selectedId}
                onChange={(value) => value && onSelect(value)}
                disabled={profiles.length === 0}
                allowDeselect={false}
                style={{ minWidth: 200 }}
              />
              <TextInput
                label="Name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                style={{ flex: 1, minWidth: 180 }}
              />
            </>
          )}
          <TextInput
            label="Note"
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            style={{ flex: 1, minWidth: 160 }}
          />
          <Button
            leftSection={<Save size={15} />}
            loading={pending === "save"}
            disabled={!canSave}
            onClick={save}
          >
            {drafting ? "Create" : "Save"}
          </Button>
          {drafting ? (
            <Button variant="default" leftSection={<X size={15} />} onClick={cancelDraft}>
              Cancel
            </Button>
          ) : current ? (
            <Button
              color="red"
              variant="default"
              leftSection={<Trash2 size={15} />}
              loading={pending === "delete"}
              disabled={profiles.length < 2}
              title={
                profiles.length < 2
                  ? "This is the only profile; make another before deleting it."
                  : "Forget this profile. Its runs stay on disk."
              }
              onClick={() =>
                run(
                  "delete",
                  async () => {
                    await api.deleteProfile(current.id)
                    setLoadedId(null)
                    await onChanged()
                  },
                  "Profile forgotten. Its runs are still on disk.",
                )
              }
            >
              Delete
            </Button>
          ) : null}
        </Group>

        {!drafting && current ? (
          <Group gap="lg">
            <Text size="sm" c="dimmed">
              {current.run_count ?? 0} runs · next run number{" "}
              <b className="tabular">{current.next_run ?? 0}</b>
            </Text>
            <Text size="sm" c="dimmed" className="tabular">
              {current.directory}
            </Text>
          </Group>
        ) : null}

        {locked ? (
          <Alert color="blue">
            A run is in progress. Editing here is safe — nothing reaches the module until the next
            run starts.
          </Alert>
        ) : null}

        {/* -- channels ---------------------------------------------------- */}

        <Group justify="space-between" align="baseline" wrap="wrap" gap="sm" mt="xs">
          <Text fw={600}>Channels</Text>
          <Group gap="xs">
            <Badge variant="light" color="grape">
              {triggers.length} trigger
            </Badge>
            <Badge variant="light" color="blue">
              {counters.length} counter
            </Badge>
          </Group>
        </Group>
        <Text size="sm" c="dimmed" mt={-8}>
          Tick the channels this experiment reads, name them, and set each input level. Selecting a
          channel changes what the DAQ tab shows — the module counts all twenty either way, and
          every run's files stay complete.
        </Text>

        {drafting && selected.length === 0 ? (
          <Text size="sm" c="orange.8">
            No channels ticked yet. A profile with none is allowed, but its DAQ tab will have
            nothing to show.
          </Text>
        ) : null}

        {/* The two halves side by side, one channel per row, so ch1 sits level
            with ch11 and the whole module is one glance rather than two. */}
        <div className="channel-columns">
          <ChannelGrid
            title="Trigger inputs — every pulse is written to the time-stamp file"
            channels={allChannels.filter((c) => triggerChannels.includes(c))}
            selected={selected}
            names={names}
            inputType={inputType}
            live={liveChannels}
            onLive={toggleLive}
            onToggle={toggle}
            onName={(channel, value) => setNames({ ...names, [String(channel)]: value })}
            onLevel={setLevel}
          />
          <ChannelGrid
            title="Scaler inputs — counted, and latched once a counting period"
            channels={allChannels.filter((c) => !triggerChannels.includes(c))}
            selected={selected}
            names={names}
            inputType={inputType}
            live={liveChannels}
            onLive={toggleLive}
            onToggle={toggle}
            onName={(channel, value) => setNames({ ...names, [String(channel)]: value })}
            onLevel={setLevel}
          />
        </div>

        {/* -- down-scale -------------------------------------------------- */}

        <Text fw={600} mt="xs">
          Down-scale
        </Text>
        <Text size="sm" c="dimmed" mt={-8}>
          Only ch{downChannels.join(", ch")} have a divider. 1 counts every pulse; 100 counts one in
          a hundred.
        </Text>
        <Group gap="md">
          {downChannels.map((channel, index) => (
            <NumberInput
              key={channel}
              label={`ch${channel}`}
              min={1}
              value={downScale[index] ?? 1}
              onChange={(value) => {
                const next = [...downScale]
                next[index] = Math.max(1, Number(value) || 1)
                setDownScale(next)
              }}
              style={{ width: 120 }}
            />
          ))}
        </Group>

        {/* -- the file itself --------------------------------------------- */}

        {!drafting && current?.setup_text ? (
          <>
            <UnstyledButton onClick={() => setShowSetup((open) => !open)} mt="xs">
              <Group gap={6}>
                {showSetup ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Text fw={600} size="sm">
                  The file the runner reads
                </Text>
              </Group>
            </UnstyledButton>
            <Collapse expanded={showSetup}>
              <Stack gap="xs">
                <Text size="sm" c="dimmed">
                  Written to <span className="tabular">{current.directory}/setup.txt</span> when a
                  run starts, so the profile's directory records what its runs were taken with.
                  Rendered by the backend, so this is literally what run_mte.exe is handed.
                </Text>
                <Code block>{current.setup_text}</Code>
              </Stack>
            </Collapse>
          </>
        ) : null}
      </Stack>

      <Modal
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import an existing setup.txt"
        size="lg"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            The first twenty-three numbers are read, exactly as the runner reads them. That is all a
            setup.txt holds — which channels the experiment reads, and what they are called, are
            this service's own idea and are picked afterwards.
          </Text>
          <TextInput
            label="Name it"
            placeholder="e.g. KO2520"
            value={importName}
            onChange={(event) => setImportName(event.currentTarget.value)}
          />
          <Textarea
            label="setup.txt"
            minRows={6}
            autosize
            styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
            value={importText}
            onChange={(event) => setImportText(event.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button
              disabled={!importName.trim() || !importText.trim()}
              loading={pending === "import"}
              onClick={() =>
                run(
                  "import",
                  async () => {
                    const saved = await api.importSetup(importName, importText)
                    setImportOpen(false)
                    setImportText("")
                    setImportName("")
                    setDrafting(false)
                    setLoadedId(null)
                    await onChanged()
                    onSelect(saved.id)
                  },
                  "Imported. Now tick the channels it reads.",
                )
              }
            >
              Import
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  )
}

/**
 * One half of the module, as a row per channel.
 *
 * A row rather than a tile, because a channel carries three things -- read it
 * or not, what it is called, what its input level is -- and a name needs
 * somewhere to be typed.
 */
function ChannelGrid({
  title,
  channels,
  selected,
  names,
  inputType,
  onToggle,
  onName,
  onLevel,
  live = [],
  onLive,
}: {
  title: string
  channels: number[]
  selected: number[]
  names: Record<string, string>
  inputType: number[]
  /** Channels the portal's live tiles show (empty = the first of each kind). */
  live?: number[]
  onLive?: (channel: number) => void
  onToggle: (channel: number) => void
  onName: (channel: number, value: string) => void
  onLevel: (channel: number, level: number) => void
}) {
  return (
    <div>
      <Text size="xs" c="dimmed" mb={4}>
        {title}
      </Text>
      <div className="channels">
        {channels.map((channel) => {
          const on = selected.includes(channel)
          const ttl = inputType[channel - 1] === 1
          return (
            <div key={channel} className={`channel-row${on ? " is-on" : ""}`}>
              <button
                type="button"
                className="channel-pick"
                onClick={() => onToggle(channel)}
                aria-pressed={on}
                aria-label={`${on ? "Stop reading" : "Read"} channel ${channel}`}
                // The tick is not the only thing saying so -- the row is tinted
                // and the name box only wakes up for a channel being read.
                title={on ? "Read by this profile" : "Not read by this profile"}
              >
                <span className="tick">{on ? "✓" : ""}</span>
                <span className="tabular">ch{channel}</span>
              </button>
              <TextInput
                size="xs"
                placeholder={on ? "name it" : ""}
                value={names[String(channel)] ?? ""}
                onChange={(event) => onName(channel, event.currentTarget.value)}
                disabled={!on}
                styles={{ input: { minHeight: 26, height: 26 } }}
              />
              {onLive ? (
                <Button
                  size="compact-xs"
                  variant={live.includes(channel) ? "filled" : "subtle"}
                  color="orange"
                  disabled={!on}
                  onClick={() => onLive(channel)}
                  title={live.includes(channel)
                    ? "Shown on the portal's live wall (click to drop it)"
                    : "Also show this channel on the portal's live wall"}
                  style={{ minWidth: 44 }}
                >
                  LIVE
                </Button>
              ) : null}
              <Button.Group>
                <Button
                  size="compact-xs"
                  variant={ttl ? "default" : "filled"}
                  color="gray"
                  onClick={() => onLevel(channel, 0)}
                >
                  NIM
                </Button>
                <Button
                  size="compact-xs"
                  variant={ttl ? "filled" : "default"}
                  onClick={() => onLevel(channel, 1)}
                >
                  TTL
                </Button>
              </Button.Group>
            </div>
          )
        })}
      </div>
    </div>
  )
}
