import Meta from "gi://Meta";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as BoxPointer from "resource:///org/gnome/shell/ui/boxpointer.js";

import { PaintSignals } from "../conveniences/paint_signals.js";
import { DummyPipeline } from "../conveniences/dummy_pipeline.js";

export const PopupMenuBlur = class PopupMenuBlur {
    constructor(connections, settings, effects_manager) {
        this.connections = connections;
        this.settings = settings;
        this.effects_manager = effects_manager;
        this.paint_signals = new PaintSignals(connections);
        this.enabled = false;
        this._tracked = new Map();
        this._window_tracked = new Map();
    }

    get _opacity() {
        return this.settings.popup_menu?.OPACITY ?? 180;
    }

    get _sigma() {
        return this.settings.popup_menu?.SIGMA ?? 30;
    }

    get _brightness() {
        return this.settings.popup_menu?.BRIGHTNESS ?? 0.6;
    }

    get _blur_app_menus() {
        return this.settings.popup_menu?.BLUR_APP_MENUS ?? true;
    }

    enable() {
        this.enabled = true;
        this._log("enabling popup menu blur");

        // Shell popup menus (BoxPointers)
        this.connections.connect(
            Main.layoutManager.uiGroup,
            "child-added", (_, actor) => {
                if (actor instanceof BoxPointer.BoxPointer)
                    this._track(actor);
            }
        );

        for (const actor of Main.layoutManager.uiGroup.get_children()) {
            if (actor instanceof BoxPointer.BoxPointer)
                this._track(actor);
        }

        // Scan status area menus including Quick Settings _boxPointer
        for (const key in Main.panel.statusArea) {
            const item = Main.panel.statusArea[key];
            const menuActor = item?.menu?.actor;
            if (menuActor instanceof BoxPointer.BoxPointer)
                this._track(menuActor);
            const bp = item?.menu?._boxPointer;
            if (bp instanceof BoxPointer.BoxPointer)
                this._track(bp);
        }

        // GTK app popup menus (Wayland popup surfaces)
        if (this._blur_app_menus) {
            this._enable_app_menu_blur();
        }
    }

    _enable_app_menu_blur() {
        this.connections.connect(
            global.display,
            "window-created", (_, meta_window) => {
                const wtype = meta_window.get_window_type();
                if (wtype === Meta.WindowType.DROPDOWN_MENU ||
                    wtype === Meta.WindowType.POPUP_MENU ||
                    wtype === Meta.WindowType.MENU) {
                    this._track_window(meta_window);
                }
            }
        );
    }

    disable() {
        this._tracked.forEach((data, actor) => {
            if (data) this._hide_blur(actor);
        });
        this._tracked.clear();

        this._window_tracked.forEach((data, mw) => {
            if (data) this._remove_window_blur(data);
        });
        this._window_tracked.clear();

        this.paint_signals.disconnect_all();
        this.enabled = false;
    }

    reset() {
        // Re-apply blur with new settings
        this._tracked.forEach((data, actor) => {
            if (data) {
                // Destroy existing blur widget
                this.paint_signals.disconnect_all_for_actor(data.blur_widget);
                try {
                    if (data.blur_widget.get_parent())
                        actor.remove_child(data.blur_widget);
                    data.blur_widget.destroy();
                } catch(e) {}
            }
            this._tracked.set(actor, null);
        });
    }

    // --- BoxPointer tracking (shell menus) ---

    _track(actor) {
        if (this._tracked.has(actor)) return;
        this._tracked.set(actor, null);

        this.connections.connect(actor, "notify::visible", () => {
            if (actor.visible)
                this._show_blur(actor);
            else
                this._hide_blur(actor);
        });

        this.connections.connect(actor, "destroy", () => {
            this._hide_blur(actor);
            this._tracked.delete(actor);
        });

        if (actor.visible)
            this._show_blur(actor);
    }

    _show_blur(actor) {
        let data = this._tracked.get(actor);

        if (!data) {
            const pipeline = new DummyPipeline(
                this.effects_manager,
                this.settings.popup_menu,
            );

            const [blur_widget, bg_manager] = pipeline.create_background_with_effect(
                actor, "bms-popup-blurred-widget"
            );

            this.paint_signals.connect(blur_widget, pipeline.effect);

            // Start hidden + 1x1 so cogl never sees a 0-sized texture.
            blur_widget.visible = false;
            blur_widget.set_size(1, 1);

            this.connections.connect(actor, "notify::allocation", () => {
                if (!actor.get_stage?.() || !actor.has_allocation?.()) return;
                const pbox = actor.get_allocation_box();
                const w = (pbox.x2 - pbox.x1) | 0;
                const h = (pbox.y2 - pbox.y1) | 0;
                if (w < 1 || h < 1) return;

                blur_widget.set_size(w, h);
                if (actor.visible) blur_widget.visible = true;

                // BoxPointer.vfunc_allocate only allocates this._border and
                // this.bin — arbitrary inserted children stay
                // priv->needs_allocation=TRUE, which makes Cogl's
                // offscreen-effect FBO fall back to allocation_box=0x0 and
                // trip the cogl_texture_2d_new_with_size 'width >= 1'
                // assertion. We call allocate() ourselves to fill that gap.
                // ORDER MATTERS: clutter_actor_allocate() bails early when
                // the actor isn't mapped, so visibility must be set first.
                if (blur_widget.mapped) {
                    const cbox = new Clutter.ActorBox();
                    cbox.x1 = 0;
                    cbox.y1 = 0;
                    cbox.x2 = w;
                    cbox.y2 = h;
                    blur_widget.allocate(cbox);
                }
            });

            data = { blur_widget, bg_manager, pipeline };
            this._tracked.set(actor, data);
        }

        // First-call fast path when the parent already has an allocation;
        // notify::allocation will pick it up otherwise.
        if (actor.has_allocation?.()) {
            const pbox = actor.get_allocation_box();
            const w = (pbox.x2 - pbox.x1) | 0;
            const h = (pbox.y2 - pbox.y1) | 0;
            if (w >= 1 && h >= 1) {
                data.blur_widget.set_size(w, h);
                data.blur_widget.visible = true;
                if (data.blur_widget.mapped) {
                    const cbox = new Clutter.ActorBox();
                    cbox.x1 = 0; cbox.y1 = 0;
                    cbox.x2 = w; cbox.y2 = h;
                    data.blur_widget.allocate(cbox);
                }
            }
        }

        const opacity = this._opacity;
        if (actor.bin) {
            actor.bin.opacity = opacity;
        } else {
            for (const child of actor.get_children()) {
                if (child !== data.blur_widget) {
                    child.opacity = opacity;
                    break;
                }
            }
        }
    }

    _hide_blur(actor) {
        const data = this._tracked.get(actor);
        if (!data) return;

        data.blur_widget.visible = false;

        if (actor.bin) {
            actor.bin.opacity = 255;
        } else {
            for (const child of actor.get_children()) {
                if (child !== data.blur_widget) {
                    child.opacity = 255;
                    break;
                }
            }
        }
    }

    // --- Window tracking (GTK app popup menus) ---

    _track_window(meta_window) {
        if (this._window_tracked.has(meta_window)) return;

        const window_actor = meta_window.get_compositor_private();
        if (!window_actor) return;

        const background_group = new Meta.BackgroundGroup({
            name: "bms-popup-bg-group",
        });

        const pipeline = new DummyPipeline(
            this.effects_manager,
            this.settings.popup_menu,
        );

        const [blur_widget, bg_manager] = pipeline.create_background_with_effect(
            background_group, "bms-popup-window-blur"
        );

        const ps = new PaintSignals(this.connections);
        ps.connect(blur_widget, pipeline.effect);

        const parent = window_actor.get_parent();
        if (parent) {
            parent.insert_child_below(background_group, window_actor);
        }

        const update = () => {
            if (!window_actor.get_stage?.()) return;
            const rect = meta_window.get_frame_rect();
            if (rect.width < 1 || rect.height < 1) return;
            background_group.set_position(rect.x, rect.y);
            background_group.set_size(rect.width, rect.height);
            blur_widget.set_size(rect.width, rect.height);
        };

        const alloc_id = window_actor.connect("notify::allocation", update);
        const stage_id = global.stage.connect("before-update", update);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            update();
            return GLib.SOURCE_REMOVE;
        });

        window_actor.opacity = this._opacity;

        const data = {
            background_group, blur_widget, bg_manager, pipeline,
            ps, parent, window_actor, alloc_id, stage_id
        };

        this._window_tracked.set(meta_window, data);

        this.connections.connect(window_actor, "destroy", () => {
            this._remove_window_blur(data);
            this._window_tracked.delete(meta_window);
        });

        this._log("blur applied to GTK popup window");
    }

    _remove_window_blur(data) {
        if (!data) return;

        data.ps?.disconnect_all();
        data.window_actor.opacity = 255;

        try { data.window_actor.disconnect(data.alloc_id); } catch(e) {}
        try { global.stage.disconnect(data.stage_id); } catch(e) {}

        try {
            if (data.background_group.get_parent())
                data.parent.remove_child(data.background_group);
            data.background_group.destroy_all_children();
            data.background_group.destroy();
        } catch(e) {}
    }

    _log(str) {
        if (this.settings.DEBUG)
            console.log(`[Blur my Shell > popup-menu] ${str}`);
    }

    _warn(str) {
        console.warn(`[Blur my Shell > popup-menu] ${str}`);
    }
};
