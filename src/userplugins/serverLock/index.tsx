/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { Guild } from "@vencord/discord-types";
import { Button, ChannelStore, ContextMenuApi, Forms, GuildStore, Menu, React, SelectedGuildStore, VoiceStateStore } from "@webpack/common";

const DATA_KEY = "ServerLock_lockedGuilds";
const STYLE_ID = "vc-serverlock-style";
const OVERLAY_ID = "vc-serverlock-overlay";
const OVERLAY_STYLE_ID = "vc-serverlock-overlay-style";
// Discord tags each server in the left sidebar with this DOM attribute:
//   data-list-item-id="guildsnav___<guildId>"
// We rely on it both for the grey-out CSS and the click/hover blocking.
const ITEM_PREFIX = "guildsnav___";

// Source of truth, kept in memory and mirrored to DataStore.
let lockedGuilds = new Set<string>();

function isGuildLocked(guildId?: string | null): boolean {
    return !!guildId && lockedGuilds.has(guildId);
}

function persist() {
    return DataStore.set(DATA_KEY, lockedGuilds);
}

function setLocked(guildId: string, locked: boolean) {
    if (locked) lockedGuilds.add(guildId);
    else lockedGuilds.delete(guildId);
    persist();
    updateLockStyle();
    updateOverlay();
}

// "LOCKED" screen shown over the channel list + chat (the middle/right) when a
// locked server's content is open — e.g. you followed an invite link into it.
// It deliberately stops at the left server rail so you can click another server
// to leave. Plain DOM + a Flux change listener; no webpack patch needed.
const OVERLAY_CSS =
    `#${OVERLAY_ID}{position:fixed;right:0;bottom:0;z-index:100;display:flex;` +
    "align-items:center;justify-content:center;" +
    "background:var(--background-base-lower,var(--background-primary,#2b2d31));}" +
    `#${OVERLAY_ID}::after{content:"LOCKED";color:var(--text-muted,#949ba4);` +
    "font-size:52px;font-weight:800;letter-spacing:8px;opacity:.5;}";

function ensureOverlayStyle() {
    if (document.getElementById(OVERLAY_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = OVERLAY_STYLE_ID;
    style.textContent = OVERLAY_CSS;
    document.head.appendChild(style);
}

// Anchor the overlay to the right edge / top of the left server rail so it
// covers everything to the right of it (channels + chat) but not the rail
// itself, and never the window title bar above the rail.
function positionOverlay(el: HTMLElement) {
    const scroller = document.querySelector('[data-list-id="guildsnav"]');
    const rail = scroller?.closest("nav") ?? scroller?.parentElement ?? scroller;
    const rect = rail?.getBoundingClientRect();
    el.style.left = `${rect ? Math.ceil(rect.right) : 72}px`;
    el.style.top = `${rect ? Math.max(0, Math.floor(rect.top)) : 0}px`;
}

function updateOverlay() {
    const locked = isGuildLocked(SelectedGuildStore?.getGuildId?.());
    let el = document.getElementById(OVERLAY_ID);

    if (!locked) {
        el?.remove();
        return;
    }

    if (!el) {
        el = document.createElement("div");
        el.id = OVERLAY_ID;
        document.body.appendChild(el);
    }
    positionOverlay(el);
}

// Inject a single <style> element that greys out every locked server icon.
// Regenerated whenever the locked set changes; survives Discord re-renders
// because it targets a stable DOM attribute rather than a React component.
function updateLockStyle() {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;

    if (lockedGuilds.size === 0) {
        el?.remove();
        return;
    }

    if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }

    const selector = [...lockedGuilds]
        .map(id => `[data-list-item-id="${ITEM_PREFIX}${id}"]`)
        .join(",");

    // pointer-events:none makes the icon physically inert — no hover popout,
    // no tooltip, no click — far more reliable than intercepting events.
    el.textContent = `${selector}{filter:grayscale(1) brightness(.65);opacity:.5;pointer-events:none!important;cursor:default!important;}`;
}

// Find the sidebar server item whose box contains a viewport point. We test
// geometry rather than the event target because a locked icon is
// pointer-events:none, so the right-click actually lands on whatever is behind it.
function guildItemAtPoint(x: number, y: number): HTMLElement | null {
    const items = Array.from(document.querySelectorAll<HTMLElement>(`[data-list-item-id^="${ITEM_PREFIX}"]`));
    for (const item of items) {
        const r = item.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return item;
    }
    return null;
}

// Because a locked icon is pointer-events:none, Discord's own context menu (with
// the "LOCKED" toggle) can't open on it — so give a minimal "Unlock" menu here.
// Right-clicks on non-locked servers fall through to Discord's normal menu.
function onServerContextMenu(e: MouseEvent) {
    const item = guildItemAtPoint(e.clientX, e.clientY);
    if (!item) return;

    const guildId = item.getAttribute("data-list-item-id")!.slice(ITEM_PREFIX.length);
    if (!lockedGuilds.has(guildId)) return;

    e.preventDefault();
    e.stopPropagation();

    // openContextMenu expects a React-style event; hand it a shim carrying the
    // cursor position and the icon as the anchor element.
    const evt = {
        currentTarget: item,
        target: item,
        clientX: e.clientX,
        clientY: e.clientY,
        pageX: e.pageX,
        pageY: e.pageY,
        nativeEvent: e,
        preventDefault() { },
        stopPropagation() { }
    } as any;

    ContextMenuApi.openContextMenu(evt, () => (
        <Menu.Menu
            navId="vc-serverlock-unlock"
            onClose={ContextMenuApi.closeContextMenu}
            aria-label="Server Lock"
        >
            <Menu.MenuItem
                id="vc-serverlock-unlock-item"
                label="Unlock"
                action={() => setLocked(guildId, false)}
            />
        </Menu.Menu>
    ));
}

const settings = definePluginSettings({
    filterActiveNow: {
        type: OptionType.BOOLEAN,
        description: "Hide voice activity from locked servers in the \"Active Now\" panel on the home page",
        default: true
    },
    lockedList: {
        type: OptionType.COMPONENT,
        description: "Locked servers",
        component: () => <LockedServersList />
    }
});

function LockedServersList() {
    const forceUpdate = useForceUpdater();
    const ids = [...lockedGuilds];

    if (ids.length === 0)
        return <Forms.FormText>No servers are locked. Right-click a server in the sidebar and choose "LOCKED".</Forms.FormText>;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ids.map(id => {
                const guild = GuildStore.getGuild(id);
                return (
                    <div
                        key={id}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                    >
                        <Forms.FormText>{guild?.name ?? `Unknown server (${id})`}</Forms.FormText>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.PRIMARY}
                            onClick={() => {
                                setLocked(id, false);
                                forceUpdate();
                            }}
                        >
                            Unlock
                        </Button>
                    </div>
                );
            })}
        </div>
    );
}

const guildContextPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (!guild) return;

    const locked = isGuildLocked(guild.id);
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuCheckboxItem
            id="vc-serverlock-toggle"
            label="LOCKED"
            checked={locked}
            action={() => setLocked(guild.id, !locked)}
        />
    );
};

export default definePlugin({
    name: "ServerLock",
    description: "Right-click a server and choose \"LOCKED\" to grey it out, make it un-clickable, suppress its hover tooltip, hide its voice activity from the \"Active Now\" panel, and show a gray LOCKED screen if its content is opened (e.g. via an invite link). Right-click again to unlock.",
    authors: [{ name: "Evan", id: 0n }],
    tags: ["Servers", "Privacy", "Utility"],
    settings,

    contextMenus: {
        "guild-context": guildContextPatch,
        "guild-header-popout": guildContextPatch
    },

    patches: [
        {
            // The "Active Now" panel (NowPlayingViewStore) builds a card per
            // friend from their voice state. We AND a locked-guild check into the
            // same condition ShowHiddenChannels anchors on, so a card for someone
            // sitting in a locked server's voice channel is never rendered.
            // NOTE: this is the most update-fragile part — see README.md if it
            // ever stops matching after a Discord update.
            find: '"NowPlayingViewStore"',
            replacement: {
                // Anchor on the same spot ShowHiddenChannels uses. The arg to
                // getVoiceStateForUser is the user id (a bare ident OR a member
                // expression like e.id), so capture it loosely and AND in our
                // locked-guild check right before the VIEW_CHANNEL permission test.
                match: /(getVoiceStateForUser\(([^)]+?)\).{0,150}?)(&&\i\.\i\.canWithPartialContext.{0,20}VIEW_CHANNEL)/,
                replace: "$1&&!$self.isUserVoiceLocked($2)$3"
            }
        }
    ],

    // Called from the Active Now patch above.
    isUserVoiceLocked(userId: string): boolean {
        if (!settings.store.filterActiveNow) return false;
        const voiceState = VoiceStateStore.getVoiceStateForUser(userId);
        if (!voiceState?.channelId) return false;
        const channel = ChannelStore.getChannel(voiceState.channelId);
        return isGuildLocked(channel?.guild_id);
    },

    async start() {
        const stored = await DataStore.get(DATA_KEY);
        // Tolerate an older array-shaped value as well as a Set.
        lockedGuilds = stored instanceof Set ? stored : new Set(Array.isArray(stored) ? stored : []);

        updateLockStyle();
        ensureOverlayStyle();
        document.addEventListener("contextmenu", onServerContextMenu, true);

        // Show/hide the LOCKED screen as the selected server changes.
        SelectedGuildStore.addChangeListener(updateOverlay);
        window.addEventListener("resize", updateOverlay);
        updateOverlay();
    },

    stop() {
        document.removeEventListener("contextmenu", onServerContextMenu, true);
        SelectedGuildStore.removeChangeListener(updateOverlay);
        window.removeEventListener("resize", updateOverlay);
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(OVERLAY_STYLE_ID)?.remove();
    }
});
