// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported ControlsManager */

const { Clutter, GObject, St } = imports.gi;

const Dash = imports.ui.dash;
const Main = imports.ui.main;
const ViewSelector = imports.ui.viewSelector;
const Overview = imports.ui.overview;

var SIDE_CONTROLS_ANIMATION_TIME = Overview.ANIMATION_TIME;

const DASH_HEIGHT_PERCENTAGE = 0.15;

var ControlsState = {
    HIDDEN: 0,
    WINDOW_PICKER: 1,
    APP_GRID: 2,
};

var DashFader = GObject.registerClass(
class DashFader extends St.Bin {
    _init(dash) {
        super._init({
            child: dash,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });

        this._dash = dash;

        Main.overview.connect('window-drag-begin', this._onWindowDragBegin.bind(this));
        Main.overview.connect('window-drag-cancelled', this._onWindowDragEnd.bind(this));
        Main.overview.connect('window-drag-end', this._onWindowDragEnd.bind(this));
    }

    _onWindowDragBegin() {
        this.ease({
            opacity: 128,
            duration: SIDE_CONTROLS_ANIMATION_TIME / 2,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onWindowDragEnd() {
        this.ease({
            opacity: 255,
            duration: SIDE_CONTROLS_ANIMATION_TIME / 2,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }
});

var ControlsManagerLayout = GObject.registerClass(
class ControlsManagerLayout extends Clutter.BinLayout {
    _init(searchEntry, viewSelector, dash, adjustment) {
        super._init();

        this._adjustment = adjustment;
        this._searchEntry = searchEntry;
        this._viewSelector = viewSelector;
        this._dash = dash;

        adjustment.connect('notify::value', () => this.layout_changed());
    }

    vfunc_set_container(container) {
        this._container = container;
    }

    vfunc_allocate(container, box) {
        const childBox = new Clutter.ActorBox();

        const spacing = container.get_theme_node().get_length('spacing');

        const [width, height] = box.get_size();
        let availableHeight = height;

        // Search entry
        const [searchHeight] = this._searchEntry.get_preferred_height(width);
        childBox.set_origin(0, 0);
        childBox.set_size(width, searchHeight);
        this._searchEntry.allocate(childBox);

        availableHeight -= searchHeight + spacing;

        // Dash
        let [dashHeight] = this._dash.get_preferred_height(width);
        dashHeight = Math.min(dashHeight,
            Math.round(box.get_height() * DASH_HEIGHT_PERCENTAGE));
        childBox.set_origin(0, height - dashHeight);
        childBox.set_size(width, dashHeight);
        this._dash.allocate(childBox);

        availableHeight -= dashHeight + spacing;

        // ViewSelector
        const initialBox = new Clutter.ActorBox();
        initialBox.set_origin(0, 0);
        initialBox.set_size(width, height);

        childBox.set_origin(0, searchHeight + spacing);
        childBox.set_size(width, availableHeight);

        const page = this._viewSelector.getActivePage();
        const progress = page === ViewSelector.ViewPage.SEARCH
            ? 1 : Math.min(this._adjustment.value, 1);
        const viewSelectorBox = initialBox.interpolate(childBox, progress);
        this._viewSelector.allocate(viewSelectorBox);
    }
});

var ControlsManager = GObject.registerClass(
class ControlsManager extends St.Widget {
    _init() {
        super._init({
            style_class: 'controls-manager',
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });

        this._animating = false;

        this._searchEntry = new St.Entry({
            style_class: 'search-entry',
            /* Translators: this is the text displayed
               in the search entry when no search is
               active; it should not exceed ~30
               characters. */
            hint_text: _('Type to search'),
            track_hover: true,
            can_focus: true,
        });
        this._searchEntry.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        const searchEntryBin = new St.Bin({
            child: this._searchEntry,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this.dash = new Dash.Dash();
        this._dashFader = new DashFader(this.dash);

        let workspaceManager = global.workspace_manager;
        let activeWorkspaceIndex = workspaceManager.get_active_workspace_index();

        this._workspaceAdjustment = new St.Adjustment({
            actor: this,
            value: activeWorkspaceIndex,
            lower: 0,
            page_increment: 1,
            page_size: 1,
            step_increment: 0,
            upper: workspaceManager.n_workspaces,
        });

        this._adjustment = new St.Adjustment({
            actor: this,
            value: ControlsState.WINDOW_PICKER,
            lower: ControlsState.HIDDEN,
            upper: ControlsState.APP_GRID,
        });

        this._nWorkspacesNotifyId =
            workspaceManager.connect('notify::n-workspaces',
                this._updateAdjustment.bind(this));

        this.viewSelector = new ViewSelector.ViewSelector(this._searchEntry,
            this._workspaceAdjustment,
            this.dash.showAppsButton,
            this._adjustment);

        this.add_child(searchEntryBin);
        this.add_child(this._dashFader);
        this.add_child(this.viewSelector);

        this.layout_manager = new ControlsManagerLayout(searchEntryBin,
            this.viewSelector, this._dashFader, this._adjustment);

        this.dash.showAppsButton.connect('notify::checked',
            this._onShowAppsButtonToggled.bind(this));

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onShowAppsButtonToggled() {
        if (this._animating)
            return;

        const checked = this.dash.showAppsButton.checked;

        const value = checked
            ? ControlsState.APP_GRID : ControlsState.WINDOW_PICKER;
        this._adjustment.remove_transition('value');
        this._adjustment.ease(value, {
            duration: SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onDestroy() {
        global.workspace_manager.disconnect(this._nWorkspacesNotifyId);
    }

    _updateAdjustment() {
        let workspaceManager = global.workspace_manager;
        let newNumWorkspaces = workspaceManager.n_workspaces;
        let activeIndex = workspaceManager.get_active_workspace_index();

        this._workspaceAdjustment.upper = newNumWorkspaces;

        // A workspace might have been inserted or removed before the active
        // one, causing the adjustment to go out of sync, so update the value
        this._workspaceAdjustment.remove_transition('value');
        this._workspaceAdjustment.value = activeIndex;
    }

    animateToOverview(onComplete) {
        this.viewSelector.animateToOverview();

        this._adjustment.value = ControlsState.HIDDEN;
        this._adjustment.ease(ControlsState.WINDOW_PICKER, {
            duration: SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete,
        });
    }

    animateFromOverview(onComplete) {
        this._animating = true;

        this.viewSelector.animateFromOverview();

        this._adjustment.ease(ControlsState.HIDDEN, {
            duration: SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this.dash.showAppsButton.checked = false;
                this._animating = false;
            },
            onComplete,
        });
    }

    get searchEntry() {
        return this._searchEntry;
    }
});
