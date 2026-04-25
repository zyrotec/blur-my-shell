import St from 'gi://St';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { PaintSignals } from '../conveniences/paint_signals.js';
import { Pipeline } from '../conveniences/pipeline.js';
import { DummyPipeline } from '../conveniences/dummy_pipeline.js';

const TRANSITION_DURATION_MS = 180;
const TRANSITION_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

export const PopupMenuBlur = class PopupMenuBlur {
    constructor(connections, settings, effects_manager) {
        this.connections = connections;
        this.settings = settings;
        this.effects_manager = effects_manager;
        this.paint_signals = new PaintSignals(connections);
        this.enabled = false;

        this.active_popup_menus = new Map();
        this._stage_connections = new Map();

        this._status_menus = new Map();
        this._shared_blur_actor = null;
        this._active_status_actor = null;
        this._status_stage_conn_id = null;
    }

    enable() {
        this._create_shared_blur_actor();
        this.scan_existing_menus();

        this.connections.connect(
            Main.panel,
            'child-added', (_, actor) => {
                this.try_track(actor);
            });

        this.connections.connect(
            Main.layoutManager.uiGroup,
            'child-added', (_, actor) => {
                this.try_track(actor);
            });
    }

    disable() {
        this.active_popup_menus.forEach(({ blur_actor }) => {
            if (blur_actor) blur_actor.destroy();
        });
        this.active_popup_menus.clear();
        this._stage_connections.clear();

        if (this._status_stage_conn_id !== null) {
            this.connections.disconnect(global.stage, this._status_stage_conn_id);
            this._status_stage_conn_id = null;
        }
        this._status_menus.forEach((_, actor) =>
            this.connections.disconnect_all_for(actor)
        );
        this._status_menus.clear();
        this._active_status_actor = null;
        this._destroy_shared_blur_actor();
    }

    reset() {}

    _create_shared_blur_actor() {
        if (this._shared_blur_actor) return;

        const actor = new St.Widget({ reactive: false, can_focus: false, visible: false });

        const pipeline = new DummyPipeline(
            this.effects_manager,
            this.settings.applications,
            actor
        );

        this.paint_signals.disconnect_all_for_actor(actor);
        this.paint_signals.connect(actor, pipeline.effect);

        Main.layoutManager.uiGroup.add_child(actor);
        Main.layoutManager.uiGroup.set_child_above_sibling(actor, null);

        this._shared_blur_actor = actor;
    }

    _destroy_shared_blur_actor() {
        if (!this._shared_blur_actor) return;
        try {
            const parent = this._shared_blur_actor.get_parent?.();
            if (parent) parent.remove_child(this._shared_blur_actor);
            this._shared_blur_actor.destroy();
        } catch (e) {
            console.warn(`[PopupMenuBlur] Error destroying shared blur actor: ${e}`);
        }
        this._shared_blur_actor = null;
    }

    _is_status_area_boxpointer(actor) {
        if (!(actor instanceof BoxPointer.BoxPointer)) return false;
        for (const key in Main.panel.statusArea) {
            const item = Main.panel.statusArea[key];
            if (item?.menu?.actor === actor) return true;
        }
        return false;
    }

    _check_if_popup_menu(actor) {
        if (!actor) return;

        if (actor instanceof BoxPointer.BoxPointer) {
            if (this._is_status_area_boxpointer(actor)) {
                this._try_track_status(actor);
            } else {
                if (!this.active_popup_menus.has(actor)) {
                    let blur_actor = this.create_blur_overlay(actor);
                    this.track(actor, blur_actor);
                }
            }
            return;
        }

        if (actor.menu?.actor instanceof BoxPointer.BoxPointer) {
            this._check_if_popup_menu(actor.menu.actor);
        }

        if (actor.get_children) {
            for (const child of actor.get_children()) {
                this._check_if_popup_menu(child);
            }
        }
    }

    scan_existing_menus() {
        for (const key in Main.panel.statusArea) {
            const item = Main.panel.statusArea[key];
            this._check_if_popup_menu(item);
        }

        for (const actor of Main.layoutManager.uiGroup.get_children()) {
            this._check_if_popup_menu(actor);
        }
    }

    try_track(actor) {
        if (actor instanceof BoxPointer.BoxPointer) {
            if (this._is_status_area_boxpointer(actor)) {
                this._try_track_status(actor);
            } else {
                let blur_actor = this.create_blur_overlay(actor);
                this.track(actor, blur_actor);
            }
            return;
        }
    }

    create_blur_overlay(popup_menu) {
        let popup_menu_actor = new St.Widget({});

        const pipeline = new DummyPipeline(
            this.effects_manager,
            this.settings.applications,
            popup_menu_actor
        );

        this.paint_signals.disconnect_all_for_actor(popup_menu_actor);
        this.paint_signals.connect(popup_menu_actor, pipeline.effect);

        popup_menu_actor.visible = false;

        this.update_dimensions(popup_menu, popup_menu_actor);
        Main.layoutManager.uiGroup.add_child(popup_menu_actor);
        Main.layoutManager.uiGroup.set_child_above_sibling(popup_menu_actor, null);

        return popup_menu_actor;
    }

    track(actor, blur_actor) {
        if (!actor) return;
        if (this.active_popup_menus.has(actor)) return;

        this.active_popup_menus.set(actor, {
            blur_actor,
            last_opacity: actor.opacity,
            force_hidden: false,
        });

        const stage_conn_id = this.connections.connect(
            global.stage,
            'before-update',
            () => {
                if (!this.active_popup_menus.has(actor)) return;
                this.update_dimensions(actor, blur_actor);
            }
        );
        this._stage_connections.set(actor, stage_conn_id);

        this.connections.connect(actor, 'notify::visible', () => {
            const data = this.active_popup_menus.get(actor);
            if (!data) return;

            if (!actor.visible) {
                data.force_hidden = true;
                data.blur_actor.visible = false;
            } else {
                data.force_hidden = false;
                data.blur_actor.visible = true;
            }
        });

        this.connections.connect(actor, 'notify::allocation', () => {
            this.update_dimensions(actor, blur_actor);
        });

        this.connections.connect(actor, 'notify::opacity', () => {
            const data = this.active_popup_menus.get(actor);
            if (!data) return;

            const currentOpacity = actor.opacity;
            const wasFullyOpen = data.last_opacity === 255;
            const isDecreasing = currentOpacity < data.last_opacity;
            const isIncreasing = currentOpacity > data.last_opacity;

            if (wasFullyOpen && isDecreasing) {
                data.force_hidden = true;
                data.blur_actor.visible = false;
            }

            if (isIncreasing && data.force_hidden) {
                data.force_hidden = false;
                data.blur_actor.visible = true;
            }

            data.last_opacity = currentOpacity;
        });

        this.connections.connect(actor, 'destroy', () => {
            this.untrack(actor);
        });

        this.check_blur(actor, blur_actor);
    }

    untrack(actor) {
        const data = this.active_popup_menus.get(actor);

        const stage_conn_id = this._stage_connections.get(actor);
        if (stage_conn_id !== undefined) {
            this.connections.disconnect(global.stage, stage_conn_id);
            this._stage_connections.delete(actor);
        }

        this.connections.disconnect_all_for(actor);

        if (data?.blur_actor) {
            const ba = data.blur_actor;
            data.blur_actor = null;

            try {
                const parent = ba.get_parent?.();
                if (parent) parent.remove_child(ba);
                ba.destroy();
            } catch (e) {
                console.warn(`[PopupMenuBlur] Error cleaning up blur_actor: ${e}`);
            }
        }

        this.active_popup_menus.delete(actor);
    }

    check_blur(actor, blur_actor) {
        if (!blur_actor) return;

        const data = this.active_popup_menus.get(actor);
        if (!data) return;

        if (data.force_hidden) {
            blur_actor.visible = false;
        }
    }

    update_dimensions(actor, blur_actor) {
        if (!actor || !blur_actor) return;
        if (!actor.get_stage?.()) return;
        if (!actor.has_allocation?.()) return;

        const data = this.active_popup_menus.get(actor);

        const show_blur_actor = () => {
            if (data?.force_hidden) return;
            blur_actor.visible = true;
        };

        if (actor instanceof BoxPointer.BoxPointer) {
            if (!actor.bin?.child) return;

            const binRect = actor.bin.get_transformed_extents?.();
            if (!binRect) return;

            const { marginTop, marginBottom, marginLeft, marginRight } =
                actor.bin.child;

            const finalX = binRect.origin.x + marginLeft;
            const finalY = binRect.origin.y + marginTop;
            const finalW = binRect.size.width - (marginLeft + marginRight);
            const finalH = binRect.size.height - (marginTop + marginBottom);

            blur_actor.set_position(finalX, finalY);
            blur_actor.set_size(finalW, finalH);
            this.sync_transition(actor, blur_actor);
            show_blur_actor();
        } else {
            const rect = actor.get_transformed_extents?.();
            if (!rect) return;

            blur_actor.set_position(rect.origin.x, rect.origin.y);
            blur_actor.set_size(rect.size.width, rect.size.height);
            show_blur_actor();
        }
    }

    set_overlay_visibility(actor, visible) {
        const data = this.active_popup_menus.get(actor);
        if (!data?.blur_actor) return;
        data.blur_actor.visible = visible;
    }

    sync_transition(actor, blur_actor) {
        const { translationX, translationY, scaleX, scaleY, opacity } = actor;
        blur_actor?.set({ translationX, translationY, scaleX, scaleY, opacity });
    }

    _try_track_status(actor) {
        if (!(actor instanceof BoxPointer.BoxPointer)) return;
        if (this._status_menus.has(actor)) return;

        this._status_menus.set(actor, {
            last_opacity: actor.opacity,
            force_hidden: !actor.visible,
        });

        this.connections.connect(actor, 'notify::visible', () => {
            const data = this._status_menus.get(actor);
            if (!data) return;

            if (actor.visible) {
                data.force_hidden = false;
                this._make_status_active(actor);
            } else {
                data.force_hidden = true;
                if (this._active_status_actor === actor) {
                    this._active_status_actor = null;
                    if (this._shared_blur_actor)
                        this._shared_blur_actor.visible = false;
                }
            }
        });

        this.connections.connect(actor, 'notify::opacity', () => {
            const data = this._status_menus.get(actor);
            if (!data) return;

            const cur = actor.opacity;
            const wasOpen = data.last_opacity === 255;
            const closing = cur < data.last_opacity;
            const opening = cur > data.last_opacity;

            if (wasOpen && closing) {
                data.force_hidden = true;
                if (this._active_status_actor === actor && this._shared_blur_actor)
                    this._shared_blur_actor.visible = false;
            }

            if (opening && data.force_hidden) {
                data.force_hidden = false;
                this._make_status_active(actor);
            }

            data.last_opacity = cur;
        });

        this.connections.connect(actor, 'notify::allocation', () => {
            if (this._active_status_actor === actor)
                this._sync_shared_actor_to(actor, true /*animate*/);
        });

        this.connections.connect(actor, 'destroy', () => {
            this._untrack_status(actor);
        });

        if (actor.visible)
            this._make_status_active(actor);

        this._ensure_status_stage_connection();
    }

    _untrack_status(actor) {
        if (this._active_status_actor === actor) {
            this._active_status_actor = null;
            if (this._shared_blur_actor)
                this._shared_blur_actor.visible = false;
        }
        this.connections.disconnect_all_for(actor);
        this._status_menus.delete(actor);

        if (this._status_menus.size === 0 && this._status_stage_conn_id !== null) {
            this.connections.disconnect(global.stage, this._status_stage_conn_id);
            this._status_stage_conn_id = null;
        }
    }

    _make_status_active(actor) {
        this._active_status_actor = actor;
        if (this._shared_blur_actor)
            Main.layoutManager.uiGroup.set_child_above_sibling(this._shared_blur_actor, null);
        this._sync_shared_actor_to(actor, false);
    }

    _sync_shared_actor_to(actor, animate) {
        const ba = this._shared_blur_actor;
        if (!ba) return;
        if (!actor.get_stage?.()) return;
        if (!actor.has_allocation?.()) return;
        if (!actor.bin?.child) return;

        const data = this._status_menus.get(actor);
        if (data?.force_hidden) {
            ba.visible = false;
            return;
        }

        const binRect = actor.bin.get_transformed_extents?.();
        if (!binRect) return;

        const { marginTop, marginBottom, marginLeft, marginRight } = actor.bin.child;

        const x = binRect.origin.x + marginLeft;
        const y = binRect.origin.y + marginTop;
        const w = binRect.size.width  - (marginLeft + marginRight);
        const h = binRect.size.height - (marginTop  + marginBottom);

        if (animate && ba.visible) {
            ba.ease({ x, y, width: w, height: h,
                duration: TRANSITION_DURATION_MS,
                mode: TRANSITION_MODE });
        } else {
            ba.set_position(x, y);
            ba.set_size(w, h);
        }

        ba.visible = true;
    }

    _ensure_status_stage_connection() {
        if (this._status_stage_conn_id !== null) return;
        this._status_stage_conn_id = this.connections.connect(
            global.stage,
            'before-update',
            () => {
                const actor = this._active_status_actor;
                if (!actor || !this._status_menus.has(actor)) return;
                this._sync_shared_actor_to(actor, false);
            }
        );
    }

    _log(str) {
        if (this.settings.DEBUG)
            console.log(`[Blur my Shell > applications] ${str}`);
    }

    _warn(str) {
        console.warn(`[Blur my Shell > applications] ${str}`);
    }
};