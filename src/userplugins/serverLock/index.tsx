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
import { Button, ChannelStore, Forms, GuildStore, Menu, React, VoiceStateStore } from "@webpack/common";

const DATA_KEY = "ServerLock_lockedGuilds";
const STYLE_ID = "vc-serverlock-style";
// Discord tags each server in the left sidebar with this DOM attribute:
//   data-list-item-id="guildsnav___<guildId>"
// We rely on it both for the grey-out CSS and the click/hover blocking.
const ITEM_PREFIX = "guildsnav___";

// Mouse/pointer events we intercept on locked servers. "contextmenu" is
// deliberately NOT in here so right-clicking a locked server still opens the
// menu (that's how you unlock it).
const BLOCKED_EVENTS = ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "mouseover", "pointerover"];
const HOVER_EVENTS = new Set(["mouseover", "pointerover"]);

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

    el.textContent = `${selector}{filter:grayscale(1) brightness(.65);opacity:.5;cursor:default!important;}`;
}

// Capture-phase guard. Runs on `document` before the event can reach React's
// listeners (mounted on the app root, a descendant of document), so navigation
// and the hover tooltip never fire for a locked server.
function onCapture(e: Event) {
    if (e.type === "contextmenu") return;

    const me = e as MouseEvent;
    // For presses/clicks only block the primary (left) button, leaving
    // right/middle clicks alone. Hover events carry no meaningful button.
    if (!HOVER_EVENTS.has(e.type) && me.button !== 0) return;

    const target = e.target as HTMLElement | null;
    const item = target?.closest?.(`[data-list-item-id^="${ITEM_PREFIX}"]`) as HTMLElement | null;
    if (!item) return;

    const guildId = item.getAttribute("data-list-item-id")!.slice(ITEM_PREFIX.length);
    if (!lockedGuilds.has(guildId)) return;

    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
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
    description: "Right-click a server and choose \"LOCKED\" to grey it out, make it un-clickable, suppress its hover tooltip, and hide its voice activity from the \"Active Now\" panel. Right-click again to unlock.",
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
                match: /(getVoiceStateForUser\((\i)\).{0,150}?)(&&\i\.\i\.canWithPartialContext.{0,20}VIEW_CHANNEL)/,
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
        for (const ev of BLOCKED_EVENTS) document.addEventListener(ev, onCapture, true);
    },

    stop() {
        for (const ev of BLOCKED_EVENTS) document.removeEventListener(ev, onCapture, true);
        document.getElementById(STYLE_ID)?.remove();
    }
});
