// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported WorkspacesView, WorkspacesDisplay */

const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;

const Main = imports.ui.main;
const SwipeTracker = imports.ui.swipeTracker;
const Workspace = imports.ui.workspace;

var { ANIMATION_TIME } = imports.ui.overview;
var WORKSPACE_SWITCH_TIME = 250;
var SCROLL_TIMEOUT_TIME = 150;

const MUTTER_SCHEMA = 'org.gnome.mutter';

const WORKSPACE_MIN_SPACING = 24;
const WORKSPACE_MAX_SPACING = 80;

var WorkspacesViewBase = GObject.registerClass({
    GTypeFlags: GObject.TypeFlags.ABSTRACT,
}, class WorkspacesViewBase extends St.Widget {
    _init(monitorIndex) {
        const { x, y, width, height } =
            Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

        super._init({
            style_class: 'workspaces-view',
            x, y, width, height,
        });
        this.connect('destroy', this._onDestroy.bind(this));
        global.focus_manager.add_group(this);

        this._monitorIndex = monitorIndex;

        this._inDrag = false;
        this._windowDragBeginId = Main.overview.connect('window-drag-begin', this._dragBegin.bind(this));
        this._windowDragEndId = Main.overview.connect('window-drag-end', this._dragEnd.bind(this));
    }

    _onDestroy() {
        this._dragEnd();

        if (this._windowDragBeginId > 0) {
            Main.overview.disconnect(this._windowDragBeginId);
            this._windowDragBeginId = 0;
        }
        if (this._windowDragEndId > 0) {
            Main.overview.disconnect(this._windowDragEndId);
            this._windowDragEndId = 0;
        }
    }

    _dragBegin() {
        this._inDrag = true;
    }

    _dragEnd() {
        this._inDrag = false;
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        for (const child of this)
            child.allocate_available_size(0, 0, box.get_width(), box.get_height());
    }
});

var WorkspacesView = GObject.registerClass(
class WorkspacesView extends WorkspacesViewBase {
    _init(monitorIndex, scrollAdjustment, snapAdjustment) {
        let workspaceManager = global.workspace_manager;

        super._init(monitorIndex);
        this.clip_to_allocation = true;

        this._snapAdjustment = snapAdjustment;
        this._snapNotifyId = this._snapAdjustment.connect('notify::value', () => {
            this.queue_relayout();
        });

        this._animating = false; // tweening
        this._gestureActive = false; // touch(pad) gestures

        this._scrollAdjustment = scrollAdjustment;
        this._onScrollId = this._scrollAdjustment.connect('notify::value',
            this._onScrollAdjustmentChanged.bind(this));

        this._workspaces = [];
        this._updateWorkspaces();
        this._updateWorkspacesId =
            workspaceManager.connect('notify::n-workspaces',
                                     this._updateWorkspaces.bind(this));
        this._reorderWorkspacesId =
            workspaceManager.connect('workspaces-reordered', () => {
                this._workspaces.sort((a, b) => {
                    return a.metaWorkspace.index() - b.metaWorkspace.index();
                });
                this._workspaces.forEach(
                    (ws, i) => this.set_child_at_index(ws, i));
            });

        this._switchWorkspaceNotifyId =
            global.window_manager.connect('switch-workspace',
                                          this._activeWorkspaceChanged.bind(this));
    }

    _getHorizontalSnapBox(box, spacing, vertical) {
        const { nWorkspaces } = global.workspaceManager;
        const [width, height] = box.get_size();
        const [workspace] = this._workspaces;

        const availableHeight = height - spacing * (nWorkspaces + 1);
        const availableWidth = width - spacing * (nWorkspaces + 1);

        const horizontalBox = new Clutter.ActorBox();

        let x1 = box.x1;
        let y1 = box.y1;

        if (vertical) {
            let workspaceHeight = availableHeight / nWorkspaces;
            let [, workspaceWidth] =
                workspace.get_preferred_width(workspaceHeight);

            y1 = spacing;
            if (workspaceWidth > width) {
                [, workspaceHeight] = workspace.get_preferred_height(width);
                y1 += Math.max((availableHeight - workspaceHeight * nWorkspaces) / 2, 0);
            }

            horizontalBox.set_size(width, workspaceHeight);
        } else {
            let workspaceWidth = availableWidth / nWorkspaces;
            let [, workspaceHeight] =
                workspace.get_preferred_height(workspaceWidth);

            x1 = spacing;
            if (workspaceHeight > height) {
                [, workspaceWidth] = workspace.get_preferred_width(height);
                x1 += Math.max((availableWidth - workspaceWidth * nWorkspaces) / 2, 0);
            }

            horizontalBox.set_size(workspaceWidth, height);
        }

        horizontalBox.set_origin(x1, y1);

        return horizontalBox;
    }

    _getVerticalSnapBox(box, spacing, vertical) {
        const [width, height] = box.get_size();
        const [workspace] = this._workspaces;

        // Snapped in the vertical axis also means horizontally centered
        let x1 = box.x1;
        let y1 = box.y1;
        if (vertical) {
            const [, workspaceHeight] = workspace.get_preferred_height(width);
            y1 += (height - workspaceHeight) / 2;
        } else {
            const [, workspaceWidth] = workspace.get_preferred_width(height);
            x1 += (width - workspaceWidth) / 2;
        }

        const verticalBox = new Clutter.ActorBox({ x1, y1 });

        if (vertical) {
            const [, workspaceHeight] = workspace.get_preferred_height(width);
            verticalBox.set_size(width, workspaceHeight);
        } else {
            const [, workspaceWidth] = workspace.get_preferred_width(height);
            verticalBox.set_size(workspaceWidth, height);
        }

        return verticalBox;
    }

    _getSpacing(box, snapAxis, vertical) {
        const [width, height] = box.get_size();
        const [workspace] = this._workspaces;

        let availableSpace;
        let workspaceSize;
        if (vertical) {
            [, workspaceSize] = workspace.get_preferred_height(width);
            availableSpace = (height - workspaceSize) / 2;
        } else {
            [, workspaceSize] = workspace.get_preferred_width(height);
            availableSpace = (width - workspaceSize) / 2;
        }

        const spacing = (availableSpace - workspaceSize * 0.05) * snapAxis;

        return Math.clamp(spacing, WORKSPACE_MIN_SPACING, WORKSPACE_MAX_SPACING);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        if (this.get_n_children() === 0)
            return;

        const vertical = global.workspaceManager.layout_rows === -1;
        const rtl = this.text_direction === Clutter.TextDirection.RTL;

        const snapProgress = this._snapAdjustment.value;

        const horizontalSpacing =
            this._getSpacing(box, Clutter.Orientation.HORIZONTAL, vertical);
        const horizontalBox =
            this._getHorizontalSnapBox(box, horizontalSpacing, vertical);

        const verticalSpacing =
            this._getSpacing(box, Clutter.Orientation.VERTICAL, vertical);
        const verticalBox =
            this._getVerticalSnapBox(box, verticalSpacing, vertical);

        // Account for RTL locales by reversing the list
        const workspaces = this._workspaces.slice();
        if (rtl)
            workspaces.reverse();

        workspaces.forEach(child => {
            if (snapProgress === 0)
                box = horizontalBox;
            else if (snapProgress === 1)
                box = verticalBox;
            else
                box = horizontalBox.interpolate(verticalBox, snapProgress);

            child.allocate_align_fill(box, 0.5, 0.5, false, false);

            if (vertical) {
                verticalBox.set_origin(
                    verticalBox.x1,
                    verticalBox.y1 + verticalBox.get_height() + verticalSpacing);
                horizontalBox.set_origin(
                    horizontalBox.x1,
                    horizontalBox.y1 + horizontalBox.get_height() + horizontalSpacing);
            } else {
                verticalBox.set_origin(
                    verticalBox.x1 + verticalBox.get_width() + verticalSpacing,
                    verticalBox.y1);
                horizontalBox.set_origin(
                    horizontalBox.x1 + horizontalBox.get_width() + horizontalSpacing,
                    horizontalBox.y1);
            }
        });

        this._updateScrollPosition();
    }

    getActiveWorkspace() {
        let workspaceManager = global.workspace_manager;
        let active = workspaceManager.get_active_workspace_index();
        return this._workspaces[active];
    }

    animateToOverview() {
        for (let w = 0; w < this._workspaces.length; w++)
            this._workspaces[w].zoomToOverview();
        this._updateScrollPosition();
    }

    animateFromOverview() {
        for (let w = 0; w < this._workspaces.length; w++)
            this._workspaces[w].zoomFromOverview();
    }

    syncStacking(stackIndices) {
        for (let i = 0; i < this._workspaces.length; i++)
            this._workspaces[i].syncStacking(stackIndices);
    }

    _scrollToActive() {
        const { workspaceManager } = global;
        const active = workspaceManager.get_active_workspace_index();

        this._animating = true;

        this._scrollAdjustment.remove_transition('value');
        this._scrollAdjustment.ease(active, {
            duration: WORKSPACE_SWITCH_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => (this._animating = false),
        });
    }

    _updateWorkspaces() {
        let workspaceManager = global.workspace_manager;
        let newNumWorkspaces = workspaceManager.n_workspaces;

        for (let j = 0; j < newNumWorkspaces; j++) {
            let metaWorkspace = workspaceManager.get_workspace_by_index(j);
            let workspace;

            if (j >= this._workspaces.length) { /* added */
                workspace = new Workspace.Workspace(metaWorkspace, this._monitorIndex);
                this.add_actor(workspace);
                this._workspaces[j] = workspace;
            } else  {
                workspace = this._workspaces[j];

                if (workspace.metaWorkspace != metaWorkspace) { /* removed */
                    workspace.destroy();
                    this._workspaces.splice(j, 1);
                } /* else kept */
            }
        }

        for (let j = this._workspaces.length - 1; j >= newNumWorkspaces; j--) {
            this._workspaces[j].destroy();
            this._workspaces.splice(j, 1);
        }

        this._updateScrollPosition();
    }

    _activeWorkspaceChanged(_wm, _from, _to, _direction) {
        if (this._scrolling)
            return;

        this._scrollToActive();
    }

    _onDestroy() {
        super._onDestroy();

        this._scrollAdjustment.disconnect(this._onScrollId);
        this._snapAdjustment.disconnect(this._snapNotifyId);
        global.window_manager.disconnect(this._switchWorkspaceNotifyId);
        let workspaceManager = global.workspace_manager;
        workspaceManager.disconnect(this._updateWorkspacesId);
        workspaceManager.disconnect(this._reorderWorkspacesId);
    }

    startTouchGesture() {
        this._gestureActive = true;
    }

    endTouchGesture() {
        this._gestureActive = false;

        this._scrollToActive();
    }

    // sync the workspaces' positions to the value of the scroll adjustment
    // and change the active workspace if appropriate
    _onScrollAdjustmentChanged() {
        if (!this.has_allocation())
            return;

        const adj = this._scrollAdjustment;
        const allowSwitch =
            adj.get_transition('value') === null && !this._gestureActive;

        let workspaceManager = global.workspace_manager;
        let active = workspaceManager.get_active_workspace_index();
        let current = Math.round(adj.value);

        if (allowSwitch && active !== current) {
            if (!this._workspaces[current]) {
                // The current workspace was destroyed. This could happen
                // when you are on the last empty workspace, and consolidate
                // windows using the thumbnail bar.
                // In that case, the intended behavior is to stay on the empty
                // workspace, which is the last one, so pick it.
                current = this._workspaces.length - 1;
            }

            let metaWorkspace = this._workspaces[current].metaWorkspace;
            metaWorkspace.activate(global.get_current_time());
        }

        this._updateScrollPosition();
    }

    _updateScrollPosition() {
        if (!this.has_allocation())
            return;

        const adj = this._scrollAdjustment;

        if (adj.upper == 1)
            return;

        const workspaceManager = global.workspace_manager;
        const vertical = workspaceManager.layout_rows === -1;
        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        const snapProgress = this._snapAdjustment.value;
        let progress = vertical || !rtl
            ? adj.value : adj.upper - adj.value;
        progress = progress / (adj.upper - 1) * snapProgress;

        // Use workspaces geometry to determine the size to offset
        const firstWorkspaceBox = rtl
            ? this._workspaces[this._workspaces.length - 1].allocation
            : this._workspaces[0].allocation;
        const lastWorkspaceBox = rtl
            ? this._workspaces[0].allocation
            : this._workspaces[this._workspaces.length - 1].allocation;
        const [workspaceWidth, workspaceHeight] = firstWorkspaceBox.get_size();
        const size = vertical
            ? lastWorkspaceBox.y2 - firstWorkspaceBox.y1 - workspaceHeight
            : lastWorkspaceBox.x2 - firstWorkspaceBox.x1 - workspaceWidth;

        for (const ws of this._workspaces) {
            if (vertical)
                ws.translation_y = -progress * size;
            else
                ws.translation_x = -progress * size;
        }
    }
});

var ExtraWorkspaceView = GObject.registerClass(
class ExtraWorkspaceView extends WorkspacesViewBase {
    _init(monitorIndex) {
        super._init(monitorIndex);
        this._workspace = new Workspace.Workspace(null, monitorIndex);
        this.add_actor(this._workspace);
    }

    getActiveWorkspace() {
        return this._workspace;
    }

    animateToOverview() {
        this._workspace.zoomToOverview();
    }

    animateFromOverview() {
        this._workspace.zoomFromOverview();
    }

    syncStacking(stackIndices) {
        this._workspace.syncStacking(stackIndices);
    }

    startTouchGesture() {
    }

    endTouchGesture() {
    }
});

var WorkspacesDisplay = GObject.registerClass(
class WorkspacesDisplay extends St.Widget {
    _init(scrollAdjustment) {
        super._init({
            visible: false,
            y_expand: true,
            clip_to_allocation: true,
        });
        this.connect('notify::allocation', this._updateWorkspacesActualGeometry.bind(this));

        this._snapAdjustment = new St.Adjustment({
            actor: this,
            value: Clutter.Orientation.VERTICAL,
            lower: Clutter.Orientation.HORIZONTAL,
            upper: Clutter.Orientation.VERTICAL,
        });

        Main.overview.connect('relayout',
            () => this._updateWorkspacesActualGeometry());

        let workspaceManager = global.workspace_manager;
        this._scrollAdjustment = scrollAdjustment;

        this._switchWorkspaceId =
            global.window_manager.connect('switch-workspace',
                this._activeWorkspaceChanged.bind(this));

        this._reorderWorkspacesdId =
            workspaceManager.connect('workspaces-reordered',
                this._workspacesReordered.bind(this));

        let clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', action => {
            // Only switch to the workspace when there's no application
            // windows open. The problem is that it's too easy to miss
            // an app window and get the wrong one focused.
            let event = Clutter.get_current_event();
            let index = this._getMonitorIndexForEvent(event);
            if ((action.get_button() == 1 || action.get_button() == 0) &&
                this._workspacesViews[index].getActiveWorkspace().isEmpty())
                Main.overview.hide();
        });
        this.bind_property('mapped', clickAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);
        this._clickAction = clickAction;

        this._swipeTracker = new SwipeTracker.SwipeTracker(
            Main.layoutManager.overviewGroup, Shell.ActionMode.OVERVIEW);
        this._swipeTracker.connect('begin', this._switchWorkspaceBegin.bind(this));
        this._swipeTracker.connect('update', this._switchWorkspaceUpdate.bind(this));
        this._swipeTracker.connect('end', this._switchWorkspaceEnd.bind(this));
        this.connect('notify::mapped', this._updateSwipeTracker.bind(this));

        this._windowDragBeginId =
            Main.overview.connect('window-drag-begin',
                this._windowDragBegin.bind(this));
        this._windowDragEndId =
            Main.overview.connect('window-drag-end',
                this._windowDragEnd.bind(this));
        this._overviewShownId = Main.overview.connect('shown', () => {
            this._syncWorkspacesActualGeometry();
        });

        this._primaryVisible = true;
        this._primaryIndex = Main.layoutManager.primaryIndex;
        this._workspacesViews = [];

        this._settings = new Gio.Settings({ schema_id: MUTTER_SCHEMA });
        this._settings.connect('changed::workspaces-only-on-primary',
                               this._workspacesOnlyOnPrimaryChanged.bind(this));
        this._workspacesOnlyOnPrimaryChanged();

        this._notifyOpacityId = 0;
        this._restackedNotifyId = 0;
        this._scrollEventId = 0;
        this._keyPressEventId = 0;
        this._scrollTimeoutId = 0;
        this._syncActualGeometryLater = 0;

        this._actualGeometry = null;
        this._inWindowDrag = false;

        this._gestureActive = false; // touch(pad) gestures
        this._canScroll = true; // limiting scrolling speed

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._notifyOpacityId) {
            let parent = this.get_parent();
            if (parent)
                parent.disconnect(this._notifyOpacityId);
            this._notifyOpacityId = 0;
        }

        if (this._parentSetLater) {
            Meta.later_remove(this._parentSetLater);
            this._parentSetLater = 0;
        }

        if (this._syncActualGeometryLater) {
            Meta.later_remove(this._syncActualGeometryLater);
            this._syncActualGeometryLater = 0;
        }

        if (this._scrollTimeoutId !== 0) {
            GLib.source_remove(this._scrollTimeoutId);
            this._scrollTimeoutId = 0;
        }

        global.window_manager.disconnect(this._switchWorkspaceId);
        global.workspace_manager.disconnect(this._reorderWorkspacesdId);
        Main.overview.disconnect(this._windowDragBeginId);
        Main.overview.disconnect(this._windowDragEndId);
        Main.overview.disconnect(this._overviewShownId);
    }

    _windowDragBegin() {
        this._inWindowDrag = true;

        const snapTransition = this._snapAdjustment.get_transition('value');
        this._previousSnapAxis = snapTransition
            ? snapTransition.get_interval().peek_final_value()
            : this._snapAdjustment.value;
        this._snapAdjustment.ease(Clutter.Orientation.HORIZONTAL, {
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._updateSwipeTracker();
    }

    _windowDragEnd() {
        this._inWindowDrag = false;

        const snapAxis = this._previousSnapAxis;
        delete this._previousSnapAxis;

        this._snapAdjustment.ease(snapAxis, {
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._updateSwipeTracker();
    }

    _updateSwipeTracker() {
        this._swipeTracker.enabled = this.mapped && !this._inWindowDrag;
    }

    _workspacesReordered() {
        let workspaceManager = global.workspace_manager;

        this._scrollAdjustment.value =
            workspaceManager.get_active_workspace_index();
    }

    _activeWorkspaceChanged(_wm, _from, to, _direction) {
        if (this._gestureActive)
            return;

        this._scrollAdjustment.ease(to, {
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            duration: WORKSPACE_SWITCH_TIME,
        });
    }

    _directionForProgress(progress) {
        if (global.workspace_manager.layout_rows === -1) {
            return progress > 0
                ? Meta.MotionDirection.DOWN
                : Meta.MotionDirection.UP;
        } else if (this.text_direction === Clutter.TextDirection.RTL) {
            return progress > 0
                ? Meta.MotionDirection.LEFT
                : Meta.MotionDirection.RIGHT;
        } else {
            return progress > 0
                ? Meta.MotionDirection.RIGHT
                : Meta.MotionDirection.LEFT;
        }
    }

    _switchWorkspaceBegin(tracker, monitor) {
        if (this._workspacesOnlyOnPrimary && monitor !== this._primaryIndex)
            return;

        let workspaceManager = global.workspace_manager;
        let adjustment = this._scrollAdjustment;
        if (this._gestureActive)
            adjustment.remove_transition('value');

        tracker.orientation = workspaceManager.layout_rows !== -1
            ? Clutter.Orientation.HORIZONTAL
            : Clutter.Orientation.VERTICAL;

        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].startTouchGesture();

        let distance = global.workspace_manager.layout_rows === -1
            ? this.height : this.width;

        let progress = adjustment.value / adjustment.page_size;
        let points = Array.from(
            { length: workspaceManager.n_workspaces }, (v, i) => i);

        tracker.confirmSwipe(distance, points, progress, Math.round(progress));

        this._gestureActive = true;
    }

    _switchWorkspaceUpdate(tracker, progress) {
        let adjustment = this._scrollAdjustment;
        adjustment.value = progress * adjustment.page_size;
    }

    _switchWorkspaceEnd(tracker, duration, endProgress) {
        this._clickAction.release();

        let workspaceManager = global.workspace_manager;
        let newWs = workspaceManager.get_workspace_by_index(endProgress);

        this._scrollAdjustment.ease(endProgress, {
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            duration,
            onComplete: () => {
                if (!newWs.active)
                    newWs.activate(global.get_current_time());
                this._endTouchGesture();
            },
        });
    }

    _endTouchGesture() {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].endTouchGesture();
        this._gestureActive = false;
    }

    vfunc_navigate_focus(from, direction) {
        return this._getPrimaryView().navigate_focus(from, direction, false);
    }

    setPrimaryWorkspaceVisible(visible) {
        if (this._primaryVisible === visible)
            return;

        this._primaryVisible = visible;

        const primaryIndex = Main.layoutManager.primaryIndex;
        const primaryWorkspace = this._workspacesViews[primaryIndex];
        if (primaryWorkspace)
            primaryWorkspace.visible = visible;
    }

    animateToOverview() {
        this.show();
        this._updateWorkspacesViews();

        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].animateToOverview();

        if (this._actualGeometry)
            this._syncWorkspacesActualGeometry();

        this._restackedNotifyId =
            Main.overview.connect('windows-restacked',
                                  this._onRestacked.bind(this));
        if (this._scrollEventId == 0)
            this._scrollEventId = Main.overview.connect('scroll-event', this._onScrollEvent.bind(this));

        if (this._keyPressEventId == 0)
            this._keyPressEventId = global.stage.connect('key-press-event', this._onKeyPressEvent.bind(this));
    }

    animateFromOverview() {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].animateFromOverview();

        const { primaryIndex } = Main.layoutManager;
        const { x, y, width, height } =
            Main.layoutManager.getWorkAreaForMonitor(primaryIndex);
        this._getPrimaryView().ease({
            x, y, width, height,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    vfunc_hide() {
        if (this._restackedNotifyId > 0) {
            Main.overview.disconnect(this._restackedNotifyId);
            this._restackedNotifyId = 0;
        }
        if (this._scrollEventId > 0) {
            Main.overview.disconnect(this._scrollEventId);
            this._scrollEventId = 0;
        }
        if (this._keyPressEventId > 0) {
            global.stage.disconnect(this._keyPressEventId);
            this._keyPressEventId = 0;
        }
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].destroy();
        this._workspacesViews = [];

        super.vfunc_hide();
    }

    _workspacesOnlyOnPrimaryChanged() {
        this._workspacesOnlyOnPrimary = this._settings.get_boolean('workspaces-only-on-primary');

        if (!Main.overview.visible)
            return;

        this._updateWorkspacesViews();
        this._syncWorkspacesActualGeometry();
    }

    _updateWorkspacesViews() {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].destroy();

        this._primaryIndex = Main.layoutManager.primaryIndex;
        this._workspacesViews = [];
        let monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            let view;
            if (this._workspacesOnlyOnPrimary && i != this._primaryIndex)
                view = new ExtraWorkspaceView(i);
            else
                view = new WorkspacesView(i, this._scrollAdjustment, this._snapAdjustment);

            this._workspacesViews.push(view);
            Main.layoutManager.overviewGroup.add_actor(view);
        }

        this._workspacesViews[this._primaryIndex].visible = this._primaryVisible;
    }

    _getMonitorIndexForEvent(event) {
        let [x, y] = event.get_coords();
        let rect = new Meta.Rectangle({ x, y, width: 1, height: 1 });
        return global.display.get_monitor_index_for_rect(rect);
    }

    _getPrimaryView() {
        if (!this._workspacesViews.length)
            return null;
        return this._workspacesViews[this._primaryIndex];
    }

    activeWorkspaceHasMaximizedWindows() {
        return this._getPrimaryView().getActiveWorkspace().hasMaximizedWindows();
    }

    vfunc_parent_set(oldParent) {
        if (oldParent && this._notifyOpacityId)
            oldParent.disconnect(this._notifyOpacityId);
        this._notifyOpacityId = 0;

        if (this._parentSetLater)
            return;

        this._parentSetLater = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._parentSetLater = 0;
            let newParent = this.get_parent();
            if (!newParent)
                return;

            // This is kinda hackish - we want the primary view to
            // appear as parent of this, though in reality it
            // is added directly to Main.layoutManager.overviewGroup
            this._notifyOpacityId = newParent.connect('notify::opacity', () => {
                let opacity = this.get_parent().opacity;
                let primaryView = this._getPrimaryView();
                if (!primaryView)
                    return;
                primaryView.opacity = opacity;
                primaryView.visible = opacity != 0;
            });
        });
    }

    _updateWorkspacesActualGeometry() {
        const [x, y] = this.get_transformed_position();
        const width = this.allocation.get_width();
        const height = this.allocation.get_height();

        this._actualGeometry = { x, y, width, height };

        if (this._syncActualGeometryLater > 0)
            return;

        this._syncActualGeometryLater =
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._syncWorkspacesActualGeometry();

                this._syncActualGeometryLater = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    _syncWorkspacesActualGeometry() {
        const primaryView = this._getPrimaryView();
        if (!primaryView)
            return;

        primaryView.ease({
            ...this._actualGeometry,
            duration: Main.overview.animationInProgress ? ANIMATION_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onRestacked(overview, stackIndices) {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].syncStacking(stackIndices);
    }

    _onScrollEvent(actor, event) {
        if (this._swipeTracker.canHandleScrollEvent(event))
            return Clutter.EVENT_PROPAGATE;

        if (!this.mapped)
            return Clutter.EVENT_PROPAGATE;

        if (this._workspacesOnlyOnPrimary &&
            this._getMonitorIndexForEvent(event) != this._primaryIndex)
            return Clutter.EVENT_PROPAGATE;

        if (!this._canScroll)
            return Clutter.EVENT_PROPAGATE;

        if (event.is_pointer_emulated())
            return Clutter.EVENT_PROPAGATE;

        let workspaceManager = global.workspace_manager;
        let activeWs = workspaceManager.get_active_workspace();
        let ws;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            ws = activeWs.get_neighbor(Meta.MotionDirection.UP);
            break;
        case Clutter.ScrollDirection.DOWN:
            ws = activeWs.get_neighbor(Meta.MotionDirection.DOWN);
            break;
        case Clutter.ScrollDirection.LEFT:
            ws = activeWs.get_neighbor(Meta.MotionDirection.LEFT);
            break;
        case Clutter.ScrollDirection.RIGHT:
            ws = activeWs.get_neighbor(Meta.MotionDirection.RIGHT);
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        Main.wm.actionMoveWorkspace(ws);

        this._canScroll = false;
        this._scrollTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            SCROLL_TIMEOUT_TIME, () => {
                this._canScroll = true;
                this._scrollTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });

        return Clutter.EVENT_STOP;
    }

    _onKeyPressEvent(actor, event) {
        if (!this.mapped)
            return Clutter.EVENT_PROPAGATE;
        let workspaceManager = global.workspace_manager;
        let activeWs = workspaceManager.get_active_workspace();
        let ws;
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Page_Up:
            ws = activeWs.get_neighbor(Meta.MotionDirection.UP);
            break;
        case Clutter.KEY_Page_Down:
            ws = activeWs.get_neighbor(Meta.MotionDirection.DOWN);
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        Main.wm.actionMoveWorkspace(ws);
        return Clutter.EVENT_STOP;
    }

    get snapAdjustment() {
        return this._snapAdjustment;
    }
});
