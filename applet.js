const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Mainloop = imports.mainloop;
const ByteArray = imports.byteArray;
const Settings = imports.ui.settings;
const Cairo = imports.cairo;
const Gettext = imports.gettext;

const UUID = 'gpuusage_cinamon@axisfx';

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');

function _(str) {
    return Gettext.dgettext(UUID, str) || str;
}

const GPU_QUERY_ARGS = [
    'nvidia-smi',
    '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,index',
    '--format=csv,noheader,nounits',
];

class GPUUsageApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        try {
            this.metadata = metadata;
            this.orientation = orientation;
            this._panelSize = panelHeight || 0;

            if (typeof this.setAllowedLayout === 'function') {
                this.setAllowedLayout(Applet.AllowedLayout.BOTH);
            }

            if (this.actor && typeof this.actor.add_style_class_name === 'function') {
                this.actor.add_style_class_name('panel-button');
            }

            this._refreshInterval = 1;
            this._showMemory = true;
            this._showTemperature = true;
            this._timeoutId = null;
            this._gpuData = [];
            this._gaugeEntries = [];
            this._lastUpdated = null;
            this._errorMessage = null;

            this._initSettings(instanceId);
            this._buildUi();
            this._initMenu(orientation);
            this._queueRefresh(true);
        } catch (error) {
            const stack = error && error.stack ? error.stack : 'no stack';
            global.logError(`[gpuusage] Failed to initialise: ${error} :: ${stack}`);
            throw error;
        }
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        this._stopTimer();

        if (this.settings) {
            this.settings.finalize();
            this.settings = null;
        }
    }

    on_panel_height_changed(height) {
        this._panelSize = height;
        this._updateSizing();
    }

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        this.menu.setOrientation(orientation);
    }

    _initSettings(instanceId) {
        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        this.settings.bind('refresh-interval', '_refreshInterval', this._restartTimer.bind(this));
        this.settings.bind('show-memory', '_showMemory', this._queueRepaint.bind(this));
        this.settings.bind('show-temperature', '_showTemperature', this._queueRepaint.bind(this));
    }

    _buildUi() {
        this._gaugesBox = new St.BoxLayout({
            vertical: false,
            style_class: 'gpuusage-panel-box',
        });
        this._gaugesBox.set_x_expand(true);
        this._gaugesBox.set_y_expand(true);
        this._gaugesBox.set_x_align(Clutter.ActorAlign.CENTER);
        this._gaugesBox.set_y_align(Clutter.ActorAlign.CENTER);
        this._gaugesBox.spacing = 6;

        this.actor.add_actor(this._gaugesBox);

        this._circleSize = this._computeCircleSize(this._getPanelHeight());
        this._ensureGaugeCount(1);
        this._updateGaugeSizing();
        this._updateTooltip();
    }

    _initMenu(orientation) {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._headerItem.actor.add_style_class_name('gpuusage-menu-header-container');
        this._headerLabel = new St.Label({
            text: _('GPU Utilisation'),
            style_class: 'gpuusage-menu-header',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._headerItem.addActor(this._headerLabel, { expand: true, align: St.Align.MIDDLE });
        this.menu.addMenuItem(this._headerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._gpuSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._gpuSection);

    }

    _computeCircleSize(panelHeight) {
        if (!panelHeight || panelHeight <= 0) {
            return 36;
        }

        return Math.max(28, Math.round(panelHeight * 0.8));
    }

    _getPanelHeight() {
        if (this.panel && typeof this.panel.height === 'number') {
            return this.panel.height;
        }

        return this._panelSize || 0;
    }

    _ensureGaugeCount(targetCount) {
        const desired = Math.max(1, targetCount);

        while (this._gaugeEntries.length < desired) {
            this._gaugeEntries.push(this._createGaugeEntry());
        }

        while (this._gaugeEntries.length > desired) {
            const entry = this._gaugeEntries.pop();
            if (entry.repaintId) {
                entry.drawing.disconnect(entry.repaintId);
            }
            entry.bin.destroy();
        }
    }

    _createGaugeEntry() {
        const entry = { info: null };

        entry.bin = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
        });
        entry.bin.set_x_align(Clutter.ActorAlign.CENTER);
        entry.bin.set_y_align(Clutter.ActorAlign.CENTER);

        entry.drawing = new St.DrawingArea({
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        entry.label = new St.Label({
            text: '--',
            style_class: 'gpuusage-label',
            reactive: false,
        });
        entry.label.set_x_align(Clutter.ActorAlign.CENTER);
        entry.label.set_y_align(Clutter.ActorAlign.CENTER);

        entry.repaintId = entry.drawing.connect('repaint', (area) => this._onGaugeRepaint(area, entry));

        entry.bin.add_actor(entry.drawing);
        entry.bin.add_actor(entry.label);
        this._gaugesBox.add_actor(entry.bin);

        return entry;
    }

    _updateGaugeSizing() {
        this._circleSize = this._computeCircleSize(this._getPanelHeight());
        const fontSize = Math.max(9, Math.round(this._circleSize * 0.32));

        for (const entry of this._gaugeEntries) {
            entry.bin.set_size(this._circleSize, this._circleSize);
            entry.drawing.set_size(this._circleSize, this._circleSize);
            entry.label.set_style(`font-size: ${fontSize}px;`);
        }

        this._queueRepaint();
    }

    _onGaugeRepaint(area, entry) {
        this._drawGauge(area, entry.info);
    }

    _drawGauge(area, info) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const size = Math.min(width, height);
        const center = size / 2;
        const lineWidth = Math.max(1, Math.round(size * 0.08));

        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();

        cr.setOperator(Cairo.Operator.OVER);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(lineWidth);

        const gpuFraction = info ? clamp01(info.gpuPercent / 100) : 0;
        const memFraction = (info && this._showMemory) ? clamp01(info.memPercent / 100) : null;
        const tempFraction = (info && this._showTemperature) ? clamp01(info.tempPercent / 100) : null;

        const rings = [
            { fraction: gpuFraction, radius: size * 0.45, color: [0, 0.784, 0.325, 1] },
            { fraction: memFraction, radius: size * 0.32, color: [0.164, 0.639, 1, 1] },
            { fraction: tempFraction, radius: size * 0.21, color: [1, 0.09, 0.267, 1] },
        ];

        cr.setSourceRGBA(0.13, 0.13, 0.13, 0.65);

        for (const ring of rings) {
            if (ring.fraction === null) {
                continue;
            }

            cr.arc(center, center, ring.radius, 0, Math.PI * 2);
            cr.stroke();
        }

        for (const ring of rings) {
            if (ring.fraction === null || ring.fraction <= 0) {
                continue;
            }

            const angle = clamp01(ring.fraction) * Math.PI * 2;
            cr.setSourceRGBA(...ring.color);
            cr.arc(center, center, ring.radius, -Math.PI / 2, -Math.PI / 2 + angle);
            cr.stroke();
        }
    }

    _updateSizing() {
        this._updateGaugeSizing();
    }

    _queueRefresh(runNow = false) {
        this._stopTimer();

        if (runNow) {
            this._updateGpuData();
        }

        this._startTimer();
    }

    _startTimer() {
        const interval = Math.max(1, this._refreshInterval);
        this._timeoutId = Mainloop.timeout_add_seconds(interval, () => {
            this._updateGpuData();
            return true;
        });
    }

    _stopTimer() {
        if (this._timeoutId) {
            Mainloop.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    _restartTimer() {
        this._queueRefresh(false);
    }

    _updateGpuData() {
        let data;

        try {
            data = this._readGpuStats();
        } catch (error) {
            this._handleError(error.message || error.toString());
            return;
        }

        this._applyData(data);
    }

    _readGpuStats() {
        let spawnResult;

        try {
            spawnResult = GLib.spawn_sync(null, GPU_QUERY_ARGS, null, GLib.SpawnFlags.SEARCH_PATH, null);
        } catch (error) {
            throw new Error(_('Unable to execute nvidia-smi: ') + error.message);
        }

        const [success, stdout, stderr, exitStatus] = spawnResult;

        if (!success) {
            throw new Error(_('Failed to query GPU statistics.'));
        }

        if (exitStatus !== 0) {
            const errText = ByteArray.toString(stderr).trim();
            throw new Error(errText || _('nvidia-smi returned a non-zero exit status.'));
        }

        const output = ByteArray.toString(stdout).trim();
        return parseGpuOutput(output);
    }

    _applyData(data) {
        this._errorMessage = null;
        this._gpuData = Array.isArray(data) ? data : [];

        const gaugeCount = this._gpuData.length > 0 ? this._gpuData.length : 1;
        this._ensureGaugeCount(gaugeCount);
        this._updateGaugeSizing();

        this._gaugeEntries.forEach((entry, index) => {
            const info = this._gpuData[index] || null;
            entry.info = info;

            if (info) {
                entry.label.set_text(info.shortLabel);
                entry.bin.visible = true;
            } else {
                entry.label.set_text('--');
                entry.bin.visible = index === 0;
            }

            entry.drawing.queue_repaint();
        });

        this._lastUpdated = new Date();

        this._updateMenu();
        this._updateTooltip();
    }

    _handleError(message) {
        this._errorMessage = message;
        this._gpuData = [];

        this._ensureGaugeCount(1);
        this._updateGaugeSizing();

        const entry = this._gaugeEntries[0];
        entry.info = null;
        entry.label.set_text('!!');
        entry.bin.visible = true;
        entry.drawing.queue_repaint();

        this._updateMenu();
        this._updateTooltip();
    }

    _updateMenu() {
        this._gpuSection.removeAll();

        if (this._errorMessage) {
            const errorItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            const errorLabel = new St.Label({ text: this._errorMessage });
            errorItem.actor.add_style_class_name('gpuusage-menu-error');
            errorItem.addActor(errorLabel, { expand: true, align: St.Align.MIDDLE });
            this._gpuSection.addMenuItem(errorItem);
            return;
        }

        if (this._gpuData.length === 0) {
            const emptyItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            emptyItem.addActor(new St.Label({ text: _('No GPU data available.') }));
            this._gpuSection.addMenuItem(emptyItem);
            return;
        }

        for (const info of this._gpuData) {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            item.actor.add_style_class_name('gpuusage-menu-item');

            const contentRow = new St.BoxLayout({
                vertical: false,
                style_class: 'gpuusage-menu-entry',
            });
            contentRow.spacing = 12;

            const gaugeSize = 52;
            const gaugeBin = new St.Bin({
                x_align: St.Align.MIDDLE,
                y_align: St.Align.MIDDLE,
            });
            const gauge = new St.DrawingArea({ reactive: false });
            gauge.set_size(gaugeSize, gaugeSize);
            gauge.connect('repaint', (area) => this._drawGauge(area, info));
            gauge.queue_repaint();
            gaugeBin.child = gauge;

            const column = new St.BoxLayout({ vertical: true });
            column.spacing = 4;
            column.set_x_expand(true);
            column.add_child(new St.Label({
                text: `${info.name} (GPU ${info.index})`,
                style_class: 'gpuusage-menu-title',
            }));

            column.add_child(this._makeLegendRow('gpu', _('Utilization: ') + info.gpuPercent + '%'));
            column.add_child(this._makeLegendRow('mem', _('Memory: ') + `${info.memUsed} / ${info.memTotal} MiB (${info.memPercent}%)`));

            if (this._showTemperature) {
                column.add_child(this._makeLegendRow('temp', _('Temperature: ') + info.tempRaw + '°C'));
            }

            contentRow.add_child(gaugeBin);
            contentRow.add_child(column);

            item.addActor(contentRow, { expand: true, align: St.Align.MIDDLE });
            this._gpuSection.addMenuItem(item);
        }
    }

    _updateTooltip() {
        if (this._errorMessage) {
            this.set_applet_tooltip(_('GPU usage monitor\n') + this._errorMessage);
            return;
        }

        if (this._gpuData.length === 0) {
            this.set_applet_tooltip(_('GPU usage monitor\nNo GPU data.'));
            return;
        }

        const lines = this._gpuData.map((info) => {
            return `${info.name} (GPU ${info.index}): ${info.gpuPercent}% GPU, ${info.memUsed}/${info.memTotal} MiB, ${info.tempRaw}°C`;
        });

        this.set_applet_tooltip(lines.join('\n'));
    }

    _queueRepaint() {
        for (const entry of this._gaugeEntries) {
            entry.drawing.queue_repaint();
        }
    }

    _makeLegendRow(colorClass, text) {
        const row = new St.BoxLayout({ style_class: 'gpuusage-menu-row' });
        row.spacing = 6;

        const dot = this._makeLegendDot(colorClass);
        dot.set_y_align(Clutter.ActorAlign.CENTER);
        row.add_child(dot);

        const label = new St.Label({
            text,
            style_class: 'gpuusage-menu-detail',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(label);

        return row;
    }

    _makeLegendDot(colorClass) {
        const dot = new St.Widget({
            style_class: `gpuusage-dot ${colorClass}`,
            reactive: false,
        });
        dot.set_size(8, 8);
        dot.set_x_align(Clutter.ActorAlign.CENTER);
        dot.set_y_align(Clutter.ActorAlign.CENTER);
        return dot;
    }
}

function clamp01(value) {
    if (Number.isNaN(value)) {
        return 0;
    }

    return Math.max(0, Math.min(1, value));
}

function parseGpuOutput(raw) {
    if (!raw) {
        return [];
    }

    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const results = [];

    for (const line of lines) {
        const parts = line.split(',').map((part) => part.trim());

        if (parts.length < 6) {
            continue;
        }

        const name = parts[0];
        const gpuPercent = Number(parts[1]);
        const memUsed = Number(parts[2]);
        const memTotal = Number(parts[3]);
        const tempRaw = Number(parts[4]);
        const index = Number(parts[5]);

        if ([gpuPercent, memUsed, memTotal, tempRaw, index].some((value) => Number.isNaN(value))) {
            continue;
        }

        const memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
        const tempPercent = Math.round(Math.min(Math.max(tempRaw, 0), 100));

        results.push({
            name,
            gpuPercent,
            memUsed,
            memTotal,
            memPercent,
            tempRaw,
            tempPercent,
            index,
            shortLabel: makeShortLabel(name, index),
        });
    }

    results.sort((a, b) => a.index - b.index);
    return results;
}

function makeShortLabel(name, fallbackIndex) {
    if (!name) {
        return `GPU${fallbackIndex}`;
    }

    const match = name.match(/\b\d{3,4}\b/) || name.match(/\b\d+\b/);
    return match ? match[0] : `GPU${fallbackIndex}`;
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new GPUUsageApplet(metadata, orientation, panelHeight, instanceId);
}
