imports.gi.versions.Pango = '1.0';

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
const Pango = imports.gi.Pango;
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

const HISTORY_LENGTH = 60; // seconds of history to retain

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
            this._tooltipStyled = false;
            this._history = new Map();

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
        this._gaugesBox.spacing = 0;
        this._gaugesBox.set_x_expand(true);
        this._gaugesBox.set_y_expand(true);
        this._gaugesBox.set_x_align(Clutter.ActorAlign.CENTER);
        this._gaugesBox.set_y_align(Clutter.ActorAlign.CENTER);

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
            entry.outer.destroy();
            entry.separator.destroy();
        }
    }

    _createGaugeEntry() {
        const entry = { info: null };

        entry.outer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
        });
        entry.outer.add_style_class_name('gpuusage-frame');
        entry.outer.set_x_expand(false);
        entry.outer.set_y_expand(false);
        entry.outer.set_x_align(Clutter.ActorAlign.CENTER);
        entry.outer.set_y_align(Clutter.ActorAlign.CENTER);

        entry.box = new St.BoxLayout({
            vertical: false,
            reactive: false,
        });
        entry.box.spacing = 0;
        entry.box.set_x_align(Clutter.ActorAlign.CENTER);
        entry.box.set_y_align(Clutter.ActorAlign.CENTER);

        entry.preLabelGap = new St.Widget({
            reactive: false,
            can_focus: false,
        });
        entry.preLabelGap.set_x_expand(false);
        entry.preLabelGap.set_y_expand(true);
        entry.preLabelGap.set_x_align(Clutter.ActorAlign.CENTER);
        entry.preLabelGap.set_y_align(Clutter.ActorAlign.CENTER);

        entry.label = new St.Label({
            text: '--',
            style_class: 'gpuusage-label',
            reactive: false,
        });
        entry.label.set_x_align(Clutter.ActorAlign.END);
        entry.label.set_y_align(Clutter.ActorAlign.CENTER);
        entry.label.set_x_expand(false);
        entry.label.set_y_expand(true);

        entry.gap = new St.Widget({
            width: 5,
            reactive: false,
        });
        entry.gap.add_style_class_name('gpuusage-gap');

        entry.drawing = new St.DrawingArea({
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        entry.drawing.set_x_expand(false);
        entry.drawing.set_y_expand(true);

        entry.barWidth = 0;
        entry.repaintId = entry.drawing.connect('repaint', (area) => this._onGaugeRepaint(area, entry));

        entry.box.add_child(entry.preLabelGap);
        entry.box.add_child(entry.label);
        entry.box.add_child(entry.gap);
        entry.box.add_child(entry.drawing);
        entry.outer.add_actor(entry.box);

        entry.separator = new St.Widget({
            width: 5,
            reactive: false,
        });
        entry.separator.add_style_class_name('gpuusage-gap');
        entry.separator.hide();

        this._gaugesBox.add_actor(entry.outer);
        this._gaugesBox.add_actor(entry.separator);

        return entry;
    }

    _updateGaugeSizing() {
        this._circleSize = this._computeCircleSize(this._getPanelHeight());
        const fontSize = Math.max(9, Math.round(this._circleSize * 0.32));

        const interGapWidth = 5;
        const labelGapWidth = interGapWidth;
        const barWidth = this._circleSize + 20;
        const totalHeight = this._circleSize;
        const framePaddingLeft = 0;
        const framePaddingRight = 4;
        const framePaddingVertical = 4;

        for (const entry of this._gaugeEntries) {
            const [, naturalLabelWidth] = entry.label.clutter_text.get_preferred_width(-1);
            const labelWidth = Math.ceil(naturalLabelWidth);
            const boxWidth = labelGapWidth + labelWidth + interGapWidth + barWidth;
            const frameWidth = boxWidth + framePaddingLeft + framePaddingRight;
            const frameHeight = totalHeight + framePaddingVertical;

            entry.outer.set_width(frameWidth);
            entry.outer.set_height(frameHeight);
            entry.box.set_width(boxWidth);
            entry.box.set_height(totalHeight);
            entry.label.set_style(`font-size: ${fontSize}px; margin: 0; padding: 0; text-align: right;`);
            entry.label.set_width(labelWidth);
            entry.label.set_y_expand(true);
            entry.preLabelGap.set_width(labelGapWidth);
            entry.gap.set_width(interGapWidth);
            entry.barWidth = barWidth;
            entry.drawing.set_size(barWidth, totalHeight);
            entry.separator.set_height(frameHeight);
        }

        this._queueRepaint();
    }

    _onGaugeRepaint(area, entry) {
        this._drawGauge(area, entry);
    }

    _drawGauge(area, entry) {
        const info = entry ? entry.info : null;
        const cr = area.get_context();
        const [totalWidth, height] = area.get_surface_size();

        if (totalWidth <= 0 || height <= 0) {
            return;
        }

        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();

        cr.setOperator(Cairo.Operator.OVER);

        const bars = [];
        bars.push({
            fraction: info ? clamp01(info.gpuPercent / 100) : 0,
            color: [0, 0.784, 0.325, 1],
        });

        if (this._showMemory) {
            bars.push({
                fraction: info ? clamp01(info.memPercent / 100) : 0,
                color: [0.164, 0.639, 1, 1],
            });
        }

        if (this._showTemperature) {
            bars.push({
                fraction: info ? clamp01(info.tempPercent / 100) : 0,
                color: [1, 0.09, 0.267, 1],
            });
        }

        if (bars.length === 0) {
            bars.push({
                fraction: 0,
                color: [0, 0.784, 0.325, 1],
            });
        }

        const barsCount = bars.length;
        const verticalInset = Math.min(height / 2, Math.max(0.5, Math.min(1, height * 0.03)));
        const availableHeight = Math.max(2, height - verticalInset * 2);
        const spacingBase = barsCount > 1 ? Math.round(availableHeight * 0.08) : 0;
        let barSpacing = Math.max(barsCount > 1 ? 2 : 0, spacingBase);
        let barHeight = Math.max(2, barsCount > 0 ? (availableHeight - barSpacing * (barsCount - 1)) / barsCount : availableHeight);
        let occupiedHeight = barHeight * barsCount + barSpacing * (barsCount - 1);

        if (occupiedHeight > availableHeight && availableHeight > 0) {
            const scale = availableHeight / occupiedHeight;
            barHeight *= scale;
            barSpacing *= scale;
            occupiedHeight = availableHeight;
        }

        const extraSpace = Math.max(0, availableHeight - occupiedHeight);
        const topOffset = verticalInset + extraSpace / 2;
        const barStartX = 0;
        const barWidth = Math.max(2, totalWidth);
        const radius = Math.max(1, barHeight / 2);

        const trackColor = [0.12, 0.12, 0.12, 0.9];

        for (let index = 0; index < bars.length; index++) {
            const row = bars[index];
            const y = topOffset + index * (barHeight + barSpacing);

            cr.setSourceRGBA(...trackColor);
            drawRoundedRect(cr, barStartX, y, barWidth, barHeight, radius);
            cr.fill();

            cr.setSourceRGBA(1, 1, 1, 0.25);
            cr.setLineWidth(1);
            drawRoundedRect(cr, barStartX + 0.5, y + 0.5, Math.max(0, barWidth - 1), Math.max(0, barHeight - 1), Math.max(0.5, radius - 0.5));
            cr.stroke();

            const fraction = row.fraction == null ? 0 : clamp01(row.fraction);
            if (fraction > 0) {
                cr.setSourceRGBA(...row.color);
                const fillWidth = Math.max(0, barWidth * fraction);
                drawRoundedRect(cr, barStartX, y, fillWidth, barHeight, radius);
                cr.fill();
            }
        }
    }

    _drawMenuGauge(area, info) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();

        if (width <= 0 || height <= 0) {
            return;
        }

        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();

        cr.setOperator(Cairo.Operator.OVER);

        const rows = [];
        rows.push({ fraction: info ? clamp01(info.gpuPercent / 100) : 0, color: [0, 0.784, 0.325, 1] });
        if (this._showMemory) {
            rows.push({ fraction: info ? clamp01(info.memPercent / 100) : 0, color: [0.164, 0.639, 1, 1] });
        }
        if (this._showTemperature) {
            rows.push({ fraction: info ? clamp01(info.tempPercent / 100) : 0, color: [1, 0.09, 0.267, 1] });
        }
        if (rows.length === 0) {
            rows.push({ fraction: 0, color: [0, 0.784, 0.325, 1] });
        }

        const rowsCount = rows.length;
        const verticalPadding = Math.max(2, Math.round(height * 0.08));
        const availableHeight = Math.max(2, height - verticalPadding * 2);
        const minSpacing = rowsCount > 1 ? 2 : 0;
        const spacingBase = rowsCount > 1 ? Math.round(availableHeight * 0.12) : 0;
        let barSpacing = Math.max(minSpacing, spacingBase);
        let barHeight = Math.max(2, rowsCount > 0 ? (availableHeight - barSpacing * (rowsCount - 1)) / rowsCount : availableHeight);
        let occupiedHeight = barHeight * rowsCount + barSpacing * (rowsCount - 1);

        if (occupiedHeight > availableHeight && availableHeight > 0) {
            const scale = availableHeight / occupiedHeight;
            barHeight *= scale;
            barSpacing *= scale;
            occupiedHeight = availableHeight;
        }

        const topOffset = verticalPadding + Math.max(0, (availableHeight - occupiedHeight) / 2);
        const paddingX = Math.max(2, Math.round(width * 0.12));
        const barWidth = Math.max(2, width - paddingX * 2);
        const radius = Math.max(1, barHeight / 2);

        const trackColor = [0.12, 0.12, 0.12, 0.9];

        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            const y = topOffset + index * (barHeight + barSpacing);

            cr.setSourceRGBA(...trackColor);
            drawRoundedRect(cr, paddingX, y, barWidth, barHeight, radius);
            cr.fill();

            cr.setSourceRGBA(1, 1, 1, 0.25);
            cr.setLineWidth(1);
            drawRoundedRect(cr, paddingX + 0.5, y + 0.5, Math.max(0, barWidth - 1), Math.max(0, barHeight - 1), Math.max(0.5, radius - 0.5));
            cr.stroke();

            const fraction = row.fraction == null ? 0 : clamp01(row.fraction);
            if (fraction > 0) {
                cr.setSourceRGBA(...row.color);
                const fillWidth = Math.max(0, barWidth * fraction);
                drawRoundedRect(cr, paddingX, y, fillWidth, barHeight, radius);
                cr.fill();
            }
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

        const seenIndices = new Set();

        this._gaugeEntries.forEach((entry, index) => {
            const info = this._gpuData[index] || null;
            entry.info = info;

            if (info) {
                entry.label.set_text(info.shortLabel);
                entry.outer.visible = true;
                seenIndices.add(info.index);
                this._recordHistorySample(info);
            } else {
                entry.label.set_text('--');
                entry.outer.visible = index === 0;
            }

            if (entry.separator) {
                if (info && index < this._gpuData.length - 1) {
                    entry.separator.show();
                } else {
                    entry.separator.hide();
                }
            }

            entry.drawing.queue_repaint();
        });

        this._lastUpdated = new Date();

        this._cleanupHistory(seenIndices);

        this._updateMenu();
        this._updateTooltip();
    }

    _recordHistorySample(info) {
        const entry = this._history.get(info.index) || { gpu: [], mem: [], temp: [] };

        const clampValue = (value) => {
            if (!Number.isFinite(value)) {
                return 0;
            }
            return Math.max(0, Math.min(100, value));
        };

        const pushValue = (array, value) => {
            array.push(clampValue(value));
            if (array.length > HISTORY_LENGTH) {
                array.shift();
            }
        };

        pushValue(entry.gpu, info.gpuPercent);
        pushValue(entry.mem, info.memPercent);
        pushValue(entry.temp, info.tempPercent);

        this._history.set(info.index, entry);
    }

    _cleanupHistory(seenIndices) {
        for (const key of Array.from(this._history.keys())) {
            if (!seenIndices.has(key)) {
                this._history.delete(key);
            }
        }
    }

    _handleError(message) {
        this._errorMessage = message;
        this._gpuData = [];

        this._ensureGaugeCount(1);
        this._updateGaugeSizing();

        const entry = this._gaugeEntries[0];
        entry.info = null;
        entry.label.set_text('!!');
        entry.outer.visible = true;
        if (entry.separator) {
            entry.separator.hide();
        }
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

        const rowItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        rowItem.actor.add_style_class_name('gpuusage-menu-item');

        const rowContainer = new St.BoxLayout({
            vertical: false,
            style_class: 'gpuusage-gpu-row',
            reactive: false,
        });
        rowContainer.spacing = 16;
        rowContainer.set_x_expand(true);

        for (const info of this._gpuData) {
            rowContainer.add_child(this._buildGpuEntry(info));
        }

        rowItem.addActor(rowContainer, { expand: true, align: St.Align.MIDDLE });
        this._gpuSection.addMenuItem(rowItem);
    }

    _buildGpuEntry(info) {
        const container = new St.BoxLayout({
            vertical: true,
            style_class: 'gpuusage-menu-entry',
            reactive: false,
        });
        container.spacing = 10;
        container.set_x_expand(true);
        container.set_y_expand(true);

        container.add_child(new St.Label({
            text: `${info.name} (GPU ${info.index})`,
            style_class: 'gpuusage-menu-title',
            x_align: Clutter.ActorAlign.START,
        }));

        const metricConfigs = [
            {
                id: 'gpu',
                title: _('Utilisation'),
                percent: info.gpuPercent,
                displayText: `${info.gpuPercent}%`,
                circleText: `${info.gpuPercent}%`,
                color: [0, 0.784, 0.325, 1],
            },
        ];

        if (this._showMemory) {
            metricConfigs.push({
                id: 'mem',
                title: _('Memory'),
                percent: info.memPercent,
                displayText: `${info.memUsed} / ${info.memTotal} MiB (${info.memPercent}%)`,
                circleText: `${info.memPercent}%`,
                color: [0.164, 0.639, 1, 1],
            });
        }

        if (this._showTemperature) {
            metricConfigs.push({
                id: 'temp',
                title: _('Temperature'),
                percent: info.tempPercent,
                displayText: `${info.tempRaw}°C (${info.tempPercent}%)`,
                circleText: `${info.tempRaw}°C`,
                color: [1, 0.09, 0.267, 1],
            });
        }

        for (const metric of metricConfigs) {
            container.add_child(this._buildMetricVisualization(info.index, metric));
        }

        return container;
    }

    _buildMetricVisualization(gpuIndex, metric) {
        const container = new St.BoxLayout({
            vertical: true,
            style_class: 'gpuusage-metric',
            reactive: false,
        });
        container.spacing = 6;
        container.set_x_expand(true);

        const header = new St.BoxLayout({
            vertical: false,
            style_class: 'gpuusage-metric-header',
            reactive: false,
        });
        header.set_x_expand(true);

        const titleLabel = new St.Label({
            text: metric.title,
            style_class: 'gpuusage-metric-title',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleLabel.set_x_expand(true);

        const valueLabel = new St.Label({
            text: metric.displayText,
            style_class: 'gpuusage-metric-value',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        valueLabel.set_x_expand(false);

        header.add_child(titleLabel);
        header.add_child(valueLabel);

        const chartArea = new St.DrawingArea({
            reactive: false,
            style_class: 'gpuusage-history-chart',
        });
        chartArea.set_height(60);
        chartArea.set_x_expand(true);
        chartArea.connect('repaint', (area) => {
            this._drawMetricHistory(area, gpuIndex, metric.id, metric.color);
        });

        const circleSection = new St.BoxLayout({
            vertical: true,
            style_class: 'gpuusage-metric-circle-section',
            reactive: false,
        });
        circleSection.set_x_expand(true);
        circleSection.set_y_align(Clutter.ActorAlign.CENTER);

        const circleWrapper = new St.Widget({
            reactive: false,
            layout_manager: new Clutter.BinLayout(),
            style_class: 'gpuusage-circle-wrapper',
        });
        circleWrapper.set_size(72, 72);
        circleWrapper.set_x_align(Clutter.ActorAlign.CENTER);
        circleWrapper.set_y_align(Clutter.ActorAlign.CENTER);

        const circleArea = new St.DrawingArea({
            reactive: false,
            style_class: 'gpuusage-circle-gauge',
        });
        circleArea.set_size(72, 72);
        circleArea.connect('repaint', (area) => {
            this._drawCircularGauge(area, metric.percent, metric.color);
        });

        const circleLabel = new St.Label({
            text: metric.circleText || metric.displayText || '',
            style_class: 'gpuusage-circle-text',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        circleLabel.set_x_expand(true);
        circleLabel.set_y_expand(true);

        circleWrapper.add_actor(circleArea);
        circleWrapper.add_actor(circleLabel);

        const circleCaption = new St.Label({
            text: metric.displayText || '',
            style_class: 'gpuusage-circle-caption',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        circleCaption.set_x_expand(true);

        circleSection.add_child(circleWrapper);
        circleSection.add_child(circleCaption);

        container.add_child(header);
        container.add_child(chartArea);
        container.add_child(circleSection);

        return container;
    }

    _drawMetricHistory(area, gpuIndex, metricId, color) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();

        if (width <= 0 || height <= 0) {
            return;
        }

        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();

        cr.setOperator(Cairo.Operator.OVER);

        const backgroundColor = [0.07, 0.07, 0.07, 0.9];
        drawRoundedRect(cr, 0, 0, width, height, 8);
        cr.setSourceRGBA(...backgroundColor);
        cr.fill();

        const padding = Math.max(6, Math.round(Math.min(width, height) * 0.12));
        const innerWidth = Math.max(1, width - padding * 2);
        const innerHeight = Math.max(1, height - padding * 2);
        const baselineY = padding + innerHeight;
        const startX = padding;

        const gridColor = [1, 1, 1, 0.06];
        const gridLines = 4;

        cr.setSourceRGBA(...gridColor);
        cr.setLineWidth(1);
        for (let i = 0; i <= gridLines; i++) {
            const y = padding + (innerHeight / gridLines) * i + 0.5;
            cr.moveTo(startX, y);
            cr.lineTo(startX + innerWidth, y);
        }
        cr.stroke();

        const historyEntry = this._history.get(gpuIndex);
        const samples = historyEntry && Array.isArray(historyEntry[metricId]) ? historyEntry[metricId] : [];
        const data = samples.slice(-HISTORY_LENGTH);

        if (data.length === 0) {
            return;
        }

        const effectiveData = data.length < 2 ? [data[0], data[0]] : data;
        const step = effectiveData.length > 1 ? innerWidth / (effectiveData.length - 1) : innerWidth;
        const lineColor = Array.isArray(color) && color.length === 4 ? color : [0, 0.784, 0.325, 1];

        cr.setSourceRGBA(lineColor[0], lineColor[1], lineColor[2], 0.2);
        cr.moveTo(startX, baselineY);
        effectiveData.forEach((value, index) => {
            const clamped = Math.max(0, Math.min(100, Number(value) || 0));
            const x = startX + step * index;
            const y = baselineY - (clamped / 100) * innerHeight;
            cr.lineTo(x, y);
        });
        cr.lineTo(startX + innerWidth, baselineY);
        cr.closePath();
        cr.fill();

        cr.setSourceRGBA(lineColor[0], lineColor[1], lineColor[2], lineColor[3] != null ? lineColor[3] : 1);
        cr.setLineWidth(Math.max(1.5, innerHeight * 0.05));
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        effectiveData.forEach((value, index) => {
            const clamped = Math.max(0, Math.min(100, Number(value) || 0));
            const x = startX + step * index;
            const y = baselineY - (clamped / 100) * innerHeight;
            if (index === 0) {
                cr.moveTo(x, y);
            } else {
                cr.lineTo(x, y);
            }
        });
        cr.stroke();
    }

    _drawCircularGauge(area, percent, color) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();

        if (width <= 0 || height <= 0) {
            return;
        }

        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();

        cr.setOperator(Cairo.Operator.OVER);

        const value = Math.max(0, Math.min(100, Number(percent) || 0));
        const strokeWidth = Math.max(4, Math.min(width, height) * 0.12);
        const radius = Math.max(1, Math.min(width, height) / 2 - strokeWidth);
        const centerX = width / 2;
        const centerY = height / 2;
        const startAngle = -Math.PI / 2;
        const sweep = (value / 100) * Math.PI * 2;

        const trackColor = [0.15, 0.15, 0.15, 0.9];
        const fillColor = Array.isArray(color) && color.length === 4 ? color : [0, 0.784, 0.325, 1];

        cr.setLineWidth(strokeWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);

        cr.setSourceRGBA(...trackColor);
        cr.arc(centerX, centerY, radius, 0, Math.PI * 2);
        cr.stroke();

        if (sweep > 0) {
            cr.setSourceRGBA(fillColor[0], fillColor[1], fillColor[2], fillColor[3] != null ? fillColor[3] : 1);
            cr.arc(centerX, centerY, radius, startAngle, startAngle + sweep);
            cr.stroke();
        }

        const innerRadius = Math.max(0, radius - strokeWidth * 0.65);
        cr.setSourceRGBA(0, 0, 0, 0.35);
        cr.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
        cr.fill();
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

        const tooltipBlocks = this._gpuData.map((info) => {
            const sections = [];
            sections.push(`<b>${info.name} (GPU ${info.index}):</b>`);
            sections.push(_('Utilisation: ') + `${info.gpuPercent}%`);
            sections.push(_('Memory: ') + `${info.memUsed} / ${info.memTotal} MiB (${info.memPercent}%)`);
            if (this._showTemperature) {
                sections.push(_('Temperature: ') + `${info.tempRaw}°C`);
            }
            return sections.join('\n');
        });

        const tooltipMarkup = tooltipBlocks.join('\n\n');
        this.set_applet_tooltip(tooltipMarkup, true);

        if (this._applet_tooltip && !this._tooltipStyled) {
            const label = this._applet_tooltip._tooltip || this._applet_tooltip.actor || null;
            if (label) {
                if (typeof label.set_x_align === 'function') {
                    label.set_x_align(Clutter.ActorAlign.START);
                }
                if (typeof label.set_x_expand === 'function') {
                    label.set_x_expand(true);
                }
                if (typeof label.set_style === 'function') {
                    label.set_style('text-align: left;');
                }
                const clutterText = label.clutter_text || (label.get_clutter_text ? label.get_clutter_text() : null);
                if (clutterText) {
                    if (typeof clutterText.set_alignment === 'function') {
                        clutterText.set_alignment(Pango.Alignment.LEFT);
                    }
                    if (typeof clutterText.set_line_alignment === 'function') {
                        clutterText.set_line_alignment(Pango.Alignment.LEFT);
                    }
                    if (typeof clutterText.set_justify === 'function') {
                        clutterText.set_justify(false);
                    }
                }
            }
            this._tooltipStyled = true;
        }
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

    const tiMatch = name.match(/\b(\d{3,4})\s*(Ti)\b/i);
    if (tiMatch) {
        return `${tiMatch[1]} ${tiMatch[2].toUpperCase()}`;
    }

    const match = name.match(/\b\d{3,4}\b/) || name.match(/\b\d+\b/);
    return match ? match[0] : `GPU${fallbackIndex}`;
}

function drawRoundedRect(cr, x, y, width, height, radius) {
    const w = Math.max(0, width);
    const h = Math.max(0, height);
    if (w <= 0 || h <= 0) {
        return;
    }

    const r = Math.min(Math.max(0, radius), w / 2, h / 2);

    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new GPUUsageApplet(metadata, orientation, panelHeight, instanceId);
}
