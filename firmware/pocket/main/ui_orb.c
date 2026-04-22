#include <string.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_sh8601.h"
#include "esp_io_expander_tca9554.h"

#include "lvgl.h"

#include "ui_orb.h"

static const char *TAG = "ui_orb";

/* SH8601 QSPI pinout — matches the Waveshare 1.8" AMOLED reference. */
#define PIN_LCD_CS    (GPIO_NUM_12)
#define PIN_LCD_PCLK  (GPIO_NUM_11)
#define PIN_LCD_D0    (GPIO_NUM_4)
#define PIN_LCD_D1    (GPIO_NUM_5)
#define PIN_LCD_D2    (GPIO_NUM_6)
#define PIN_LCD_D3    (GPIO_NUM_7)

#define LCD_H_RES 368
#define LCD_V_RES 448
#define LCD_BIT_PER_PIXEL 16

#define LVGL_TICK_PERIOD_MS     2
#define LVGL_TASK_MAX_DELAY_MS  30
#define LVGL_TASK_MIN_DELAY_MS  5
#define LVGL_TASK_STACK         (6 * 1024)
#define LVGL_TASK_PRIO          2
#define LVGL_BUF_LINES          20   /* 368 × 20 × 2 = ~14 KB per buffer (DMA-capable) */

/* Orb geometry — ~30% of the old placeholder. Container is larger than the
 * biggest drawn element so transform-zoom can breathe without clipping. */
#define ORB_BOX           200
#define ORB_OUTER_RING    150
#define ORB_INNER_RING    110
#define ORB_CORE          70
#define RING_WIDTH_OUTER  5
#define RING_WIDTH_INNER  3

/* Colors — see docs/orb-ui.md. LVGL takes 24-bit RGB and reduces to RGB565. */
#define COLOR_IDLE       lv_color_make(0x1a, 0x1a, 0x3a)
#define COLOR_LISTENING  lv_color_make(0x00, 0xd8, 0xff)
#define COLOR_THINKING   lv_color_make(0xff, 0xb0, 0x20)
#define COLOR_SPEAKING   lv_color_make(0xf0, 0xf0, 0xff)
#define COLOR_ERROR      lv_color_make(0xff, 0x30, 0x30)

static const sh8601_lcd_init_cmd_t s_init_cmds[] = {
    {0x11, (uint8_t[]){0x00}, 0, 120},
    {0x44, (uint8_t[]){0x01, 0xD1}, 2, 0},
    {0x35, (uint8_t[]){0x00}, 1, 0},
    {0x53, (uint8_t[]){0x20}, 1, 10},
    {0x2A, (uint8_t[]){0x00, 0x00, 0x01, 0x6F}, 4, 0},
    {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xBF}, 4, 0},
    {0x51, (uint8_t[]){0x00}, 1, 10},
    {0x29, (uint8_t[]){0x00}, 0, 10},
    {0x51, (uint8_t[]){0xFF}, 1, 0},
};

static esp_lcd_panel_handle_t s_panel = NULL;
static QueueHandle_t s_state_q = NULL;
static SemaphoreHandle_t s_lvgl_mux = NULL;

/* Orb = core + two arc rings.
 *   - core breathes (transform zoom) in every state; speed/depth encode state.
 *   - outer/inner rings counter-rotate for "thinking" (metamorphosis feel).
 *   - listening adds a cyan ripple on the outer ring.
 *   - error flashes the core's opacity.  */
static lv_obj_t *s_core = NULL;
static lv_obj_t *s_ring_outer = NULL;
static lv_obj_t *s_ring_inner = NULL;

static lv_color_t color_for_state(pocket_orb_state_t s)
{
    switch (s) {
    case POCKET_ORB_LISTENING: return COLOR_LISTENING;
    case POCKET_ORB_THINKING:  return COLOR_THINKING;
    case POCKET_ORB_SPEAKING:  return COLOR_SPEAKING;
    case POCKET_ORB_ERROR:     return COLOR_ERROR;
    case POCKET_ORB_IDLE:
    default:                   return COLOR_IDLE;
    }
}

static const char *name_for_state(pocket_orb_state_t s)
{
    switch (s) {
    case POCKET_ORB_LISTENING: return "listening";
    case POCKET_ORB_THINKING:  return "thinking";
    case POCKET_ORB_SPEAKING:  return "speaking";
    case POCKET_ORB_ERROR:     return "error";
    default:                   return "idle";
    }
}

static bool lvgl_lock(int timeout_ms)
{
    const TickType_t t = (timeout_ms < 0) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    return xSemaphoreTake(s_lvgl_mux, t) == pdTRUE;
}

static void lvgl_unlock(void) { xSemaphoreGive(s_lvgl_mux); }

/* ---------- animation callbacks ---------- */

/* Breathe via actual size rather than transform_zoom. Transform scales the
 * drawn pixels but leaves the bbox fixed, so growing past 100% scatters
 * pixels that the next frame's invalidation can't erase — the "glitching"
 * flicker. Resizing invalidates the bbox each frame, so nothing leaks. */
static void anim_size_cb(void *var, int32_t v)
{
    lv_obj_set_size((lv_obj_t *)var, v, v);
}

static void anim_opa_cb(void *var, int32_t v)
{
    lv_obj_set_style_opa((lv_obj_t *)var, (lv_opa_t)v, 0);
}

static void anim_rot_cb(void *var, int32_t v)
{
    lv_arc_set_rotation((lv_obj_t *)var, (uint16_t)(v & 0x1FF));
    lv_obj_invalidate((lv_obj_t *)var);
}

static void anim_arc_width_cb(void *var, int32_t v)
{
    lv_obj_set_style_arc_width((lv_obj_t *)var, v, LV_PART_MAIN);
    lv_obj_invalidate((lv_obj_t *)var);
}

static void anim_arc_opa_cb(void *var, int32_t v)
{
    lv_obj_set_style_arc_opa((lv_obj_t *)var, (lv_opa_t)v, LV_PART_MAIN);
}

/* ---------- per-state scene configuration ---------- */

static void cancel_all_anims(void)
{
    lv_anim_del(s_core, NULL);
    lv_anim_del(s_ring_outer, NULL);
    lv_anim_del(s_ring_inner, NULL);
}

/* Helper: start an infinite back-and-forth animation on `obj`. */
static void start_pingpong(lv_obj_t *obj, lv_anim_exec_xcb_t cb,
                           int32_t from, int32_t to, uint32_t time_ms)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, obj);
    lv_anim_set_exec_cb(&a, cb);
    lv_anim_set_values(&a, from, to);
    lv_anim_set_time(&a, time_ms);
    lv_anim_set_playback_time(&a, time_ms);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
    lv_anim_start(&a);
}

/* Helper: start a one-way looping animation (for rotation). */
static void start_loop(lv_obj_t *obj, lv_anim_exec_xcb_t cb,
                       int32_t from, int32_t to, uint32_t time_ms)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, obj);
    lv_anim_set_exec_cb(&a, cb);
    lv_anim_set_values(&a, from, to);
    lv_anim_set_time(&a, time_ms);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_linear);
    lv_anim_start(&a);
}

static void set_ring_visible(lv_obj_t *ring, lv_color_t color, lv_opa_t opa, int width)
{
    lv_obj_set_style_arc_color(ring, color, LV_PART_MAIN);
    lv_obj_set_style_arc_opa(ring, opa, LV_PART_MAIN);
    lv_obj_set_style_arc_width(ring, width, LV_PART_MAIN);
}

static void apply_state(pocket_orb_state_t s)
{
    static pocket_orb_state_t last = (pocket_orb_state_t)-1;
    if (!s_core) return;
    if (s == last) return;   /* avoid jitter when WS retries fire repeated errors */
    last = s;
    if (!lvgl_lock(50)) return;

    cancel_all_anims();

    lv_color_t c = color_for_state(s);

    /* Reset the core to fully opaque + base size; state-specific anims override.
     * Keeps transitions clean — you never inherit a half-animated value from
     * the previous state. */
    lv_obj_set_style_bg_color(s_core, c, 0);
    lv_obj_set_style_opa(s_core, LV_OPA_COVER, 0);
    lv_obj_set_size(s_core, ORB_CORE, ORB_CORE);

    /* Default: rings hidden. Individual states un-hide what they need. */
    set_ring_visible(s_ring_outer, c, LV_OPA_TRANSP, RING_WIDTH_OUTER);
    set_ring_visible(s_ring_inner, c, LV_OPA_TRANSP, RING_WIDTH_INNER);
    lv_arc_set_rotation(s_ring_outer, 0);
    lv_arc_set_rotation(s_ring_inner, 0);

    /* Size ranges are absolute pixel values (core = ORB_CORE = 70 nominal). */
    switch (s) {
    case POCKET_ORB_IDLE:
        /* Quietly alive: slow core breath + faint arc drifting clockwise. */
        start_pingpong(s_core, anim_size_cb, 64, 72, 2400);
        set_ring_visible(s_ring_outer, c, LV_OPA_40, RING_WIDTH_OUTER);
        start_loop(s_ring_outer, anim_rot_cb, 0, 360, 7000);
        break;

    case POCKET_ORB_LISTENING:
        /* Alert: faster pulse, both arcs live and counter-rotating. */
        start_pingpong(s_core, anim_size_cb, 66, 84, 600);
        set_ring_visible(s_ring_outer, c, LV_OPA_80, RING_WIDTH_OUTER);
        set_ring_visible(s_ring_inner, c, LV_OPA_60, RING_WIDTH_INNER);
        start_loop(s_ring_outer, anim_rot_cb, 0, 360, 1400);
        start_loop(s_ring_inner, anim_rot_cb, 360, 0, 1000);
        break;

    case POCKET_ORB_THINKING:
        /* Metamorphosis: core dim + small, arcs spin opposite directions. */
        start_pingpong(s_core, anim_size_cb, 54, 66, 1100);
        set_ring_visible(s_ring_outer, c, LV_OPA_90, RING_WIDTH_OUTER + 1);
        set_ring_visible(s_ring_inner, c, LV_OPA_70, RING_WIDTH_INNER + 1);
        start_loop(s_ring_outer, anim_rot_cb, 0, 360, 1800);
        start_loop(s_ring_inner, anim_rot_cb, 360, 0, 1200);
        break;

    case POCKET_ORB_SPEAKING:
        /* Fast speech-like pulse, rings slowly sweep behind it. */
        start_pingpong(s_core, anim_size_cb, 68, 90, 380);
        set_ring_visible(s_ring_outer, c, LV_OPA_50, RING_WIDTH_OUTER);
        set_ring_visible(s_ring_inner, c, LV_OPA_70, RING_WIDTH_INNER + 1);
        start_loop(s_ring_outer, anim_rot_cb, 0, 360, 2600);
        start_pingpong(s_ring_inner, anim_arc_width_cb, RING_WIDTH_INNER, RING_WIDTH_INNER + 4, 380);
        break;

    case POCKET_ORB_ERROR:
        /* Unmistakable NOT-CONNECTED: core opacity flash + BOTH rings red,
         * spinning fast in opposite directions. No size change on the core so
         * it reads as a warning sign, not a breath. */
        start_pingpong(s_core, anim_opa_cb, LV_OPA_30, LV_OPA_COVER, 280);
        set_ring_visible(s_ring_outer, c, LV_OPA_90, RING_WIDTH_OUTER + 1);
        set_ring_visible(s_ring_inner, c, LV_OPA_80, RING_WIDTH_INNER + 1);
        start_loop(s_ring_outer, anim_rot_cb, 0, 360, 700);
        start_loop(s_ring_inner, anim_rot_cb, 360, 0, 500);
        break;
    }

    lvgl_unlock();
}

/* ---------- scene construction ---------- */

/* Partial arc — visually more interesting than a full ring because rotation
 * becomes legible (your eye tracks the gap). */
static lv_obj_t *make_ring(lv_obj_t *parent, int size, int width, int arc_deg)
{
    lv_obj_t *arc = lv_arc_create(parent);
    lv_obj_set_size(arc, size, size);
    lv_obj_center(arc);
    lv_arc_set_bg_angles(arc, 0, arc_deg);
    lv_arc_set_value(arc, 0);
    lv_obj_remove_style(arc, NULL, LV_PART_KNOB);
    lv_obj_remove_style(arc, NULL, LV_PART_INDICATOR);
    lv_obj_clear_flag(arc, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_arc_width(arc, width, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(arc, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(arc, 0, 0);
    return arc;
}

static void build_scene(void)
{
    lv_obj_t *scr = lv_scr_act();
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    /* Transparent container so transform-zoom on the core has headroom and
     * the rings all share a common center. */
    lv_obj_t *box = lv_obj_create(scr);
    lv_obj_set_size(box, ORB_BOX, ORB_BOX);
    lv_obj_center(box);
    lv_obj_set_style_bg_opa(box, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(box, 0, 0);
    lv_obj_set_style_pad_all(box, 0, 0);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);

    s_ring_outer = make_ring(box, ORB_OUTER_RING, RING_WIDTH_OUTER, 120);
    s_ring_inner = make_ring(box, ORB_INNER_RING, RING_WIDTH_INNER, 80);

    s_core = lv_obj_create(box);
    lv_obj_set_size(s_core, ORB_CORE, ORB_CORE);
    lv_obj_center(s_core);
    lv_obj_set_style_radius(s_core, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(s_core, 0, 0);
    lv_obj_set_style_pad_all(s_core, 0, 0);
    lv_obj_set_style_bg_color(s_core, COLOR_IDLE, 0);
    lv_obj_set_style_bg_opa(s_core, LV_OPA_COVER, 0);
    lv_obj_clear_flag(s_core, LV_OBJ_FLAG_SCROLLABLE);
}

/* ---------- LCD + LVGL infra ---------- */

static bool lvgl_flush_ready_cb(esp_lcd_panel_io_handle_t io,
                                esp_lcd_panel_io_event_data_t *edata, void *ctx)
{
    lv_disp_drv_t *drv = (lv_disp_drv_t *)ctx;
    lv_disp_flush_ready(drv);
    return false;
}

static void lvgl_flush_cb(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *map)
{
    esp_lcd_panel_handle_t panel = (esp_lcd_panel_handle_t)drv->user_data;
    esp_lcd_panel_draw_bitmap(panel, area->x1, area->y1, area->x2 + 1, area->y2 + 1, map);
}

/* SH8601 wants even-aligned coordinate pairs; round areas out by one pixel. */
static void lvgl_rounder_cb(struct _lv_disp_drv_t *drv, lv_area_t *area)
{
    area->x1 = (area->x1 >> 1) << 1;
    area->y1 = (area->y1 >> 1) << 1;
    area->x2 = ((area->x2 >> 1) << 1) + 1;
    area->y2 = ((area->y2 >> 1) << 1) + 1;
}

static void lvgl_update_cb(lv_disp_drv_t *drv)
{
    /* No-op — mirror is set once at init and SH8601 has no swap_xy. */
    (void)drv;
}

static void lvgl_tick_cb(void *arg) { lv_tick_inc(LVGL_TICK_PERIOD_MS); }

static void lvgl_task(void *arg)
{
    uint32_t delay_ms = LVGL_TASK_MAX_DELAY_MS;
    while (1) {
        pocket_orb_state_t s;
        while (xQueueReceive(s_state_q, &s, 0) == pdTRUE) {
            ESP_LOGI(TAG, "state -> %s", name_for_state(s));
            apply_state(s);
        }
        if (lvgl_lock(-1)) {
            delay_ms = lv_timer_handler();
            lvgl_unlock();
        }
        if (delay_ms > LVGL_TASK_MAX_DELAY_MS) delay_ms = LVGL_TASK_MAX_DELAY_MS;
        if (delay_ms < LVGL_TASK_MIN_DELAY_MS) delay_ms = LVGL_TASK_MIN_DELAY_MS;
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
}

/* The Waveshare board routes LCD reset / backlight through a TCA9554 IO expander
 * on the shared I2C bus (same bus as ES8311). Mirror the smoketest's sequence. */
static esp_err_t power_up_display(void)
{
    esp_io_expander_handle_t io = NULL;
    esp_err_t err = esp_io_expander_new_i2c_tca9554(
        0 /* I2C_NUM_0 — already installed by es8311_codec_init() */,
        ESP_IO_EXPANDER_I2C_TCA9554_ADDRESS_000, &io);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "tca9554 init failed: %s", esp_err_to_name(err));
        return err;
    }
    esp_io_expander_set_dir(io,
        IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_2,
        IO_EXPANDER_OUTPUT);
    esp_io_expander_set_level(io, IO_EXPANDER_PIN_NUM_0, 0);
    esp_io_expander_set_level(io, IO_EXPANDER_PIN_NUM_1, 0);
    esp_io_expander_set_level(io, IO_EXPANDER_PIN_NUM_2, 0);
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_io_expander_set_level(io, IO_EXPANDER_PIN_NUM_0, 1);
    esp_io_expander_set_level(io, IO_EXPANDER_PIN_NUM_1, 1);
    esp_io_expander_set_level(io, IO_EXPANDER_PIN_NUM_2, 1);
    return ESP_OK;
}

esp_err_t ui_orb_start(void)
{
    static lv_disp_draw_buf_t draw_buf;
    static lv_disp_drv_t disp_drv;

    s_state_q = xQueueCreate(8, sizeof(pocket_orb_state_t));
    s_lvgl_mux = xSemaphoreCreateMutex();
    if (!s_state_q || !s_lvgl_mux) return ESP_ERR_NO_MEM;

    ESP_ERROR_CHECK(power_up_display());

    ESP_LOGI(TAG, "SPI bus init (QSPI)");
    const spi_bus_config_t bus = SH8601_PANEL_BUS_QSPI_CONFIG(
        PIN_LCD_PCLK, PIN_LCD_D0, PIN_LCD_D1, PIN_LCD_D2, PIN_LCD_D3,
        LCD_H_RES * LCD_V_RES * LCD_BIT_PER_PIXEL / 8);
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

    ESP_LOGI(TAG, "Panel IO");
    esp_lcd_panel_io_handle_t io_h = NULL;
    const esp_lcd_panel_io_spi_config_t io_cfg = SH8601_PANEL_IO_QSPI_CONFIG(
        PIN_LCD_CS, lvgl_flush_ready_cb, &disp_drv);
    sh8601_vendor_config_t vcfg = {
        .init_cmds = s_init_cmds,
        .init_cmds_size = sizeof(s_init_cmds) / sizeof(s_init_cmds[0]),
        .flags = { .use_qspi_interface = 1 },
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io_cfg, &io_h));

    const esp_lcd_panel_dev_config_t pcfg = {
        .reset_gpio_num = -1,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = LCD_BIT_PER_PIXEL,
        .vendor_config = &vcfg,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_sh8601(io_h, &pcfg, &s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(s_panel));
    /* SH8601 driver has no swap_xy; mirror is enough. Panel stays OFF until
     * LVGL has painted a full black frame below — otherwise the panel's
     * power-on GRAM contents (mostly white) flash briefly at boot. */
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(s_panel, true, false));

    ESP_LOGI(TAG, "LVGL init");
    lv_init();

    lv_color_t *b1 = heap_caps_malloc(LCD_H_RES * LVGL_BUF_LINES * sizeof(lv_color_t), MALLOC_CAP_DMA);
    lv_color_t *b2 = heap_caps_malloc(LCD_H_RES * LVGL_BUF_LINES * sizeof(lv_color_t), MALLOC_CAP_DMA);
    if (!b1 || !b2) {
        ESP_LOGE(TAG, "draw buf alloc failed");
        return ESP_ERR_NO_MEM;
    }
    lv_disp_draw_buf_init(&draw_buf, b1, b2, LCD_H_RES * LVGL_BUF_LINES);

    lv_disp_drv_init(&disp_drv);
    disp_drv.hor_res = LCD_H_RES;
    disp_drv.ver_res = LCD_V_RES;
    disp_drv.flush_cb = lvgl_flush_cb;
    disp_drv.rounder_cb = lvgl_rounder_cb;
    disp_drv.drv_update_cb = lvgl_update_cb;
    disp_drv.draw_buf = &draw_buf;
    disp_drv.user_data = s_panel;
    lv_disp_drv_register(&disp_drv);

    const esp_timer_create_args_t tick_args = { .callback = &lvgl_tick_cb, .name = "lvgl_tick" };
    esp_timer_handle_t tick = NULL;
    ESP_ERROR_CHECK(esp_timer_create(&tick_args, &tick));
    ESP_ERROR_CHECK(esp_timer_start_periodic(tick, LVGL_TICK_PERIOD_MS * 1000));

    if (lvgl_lock(-1)) {
        build_scene();
        /* Force LVGL to paint every pixel of the screen (default: black) into
         * the panel's GRAM before the display is turned on. This overwrites
         * the power-on white so no stale rows show at the edges. */
        lv_obj_invalidate(lv_scr_act());
        lv_refr_now(NULL);
        lvgl_unlock();
    }

    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, true));

    xTaskCreate(lvgl_task, "lvgl", LVGL_TASK_STACK, NULL, LVGL_TASK_PRIO, NULL);

    /* Prime the queue with idle so the animation starts immediately even if
     * the first external state change is a long way off. */
    ui_orb_set_state(POCKET_ORB_IDLE);
    return ESP_OK;
}

void ui_orb_set_state(pocket_orb_state_t state)
{
    if (!s_state_q) return;
    xQueueSend(s_state_q, &state, 0);
}

/* Minimal, allocation-free scanner for {"orb":"<name>"}. Avoids pulling in cJSON
 * just to read one field. Returns quickly on any malformed input. */
void ui_orb_apply_text_frame(const char *json, int len)
{
    if (!json || len <= 0) return;
    static const char KEY[] = "\"orb\"";
    const char *end = json + len;
    const char *p = NULL;
    for (const char *q = json; q + (int)sizeof(KEY) - 1 <= end; q++) {
        if (memcmp(q, KEY, sizeof(KEY) - 1) == 0) { p = q + sizeof(KEY) - 1; break; }
    }
    if (!p) return;
    while (p < end && (*p == ' ' || *p == ':')) p++;
    if (p >= end || *p != '"') return;
    p++;
    const char *v = p;
    while (p < end && *p != '"') p++;
    int vlen = (int)(p - v);
    if (vlen <= 0) return;

    struct { const char *name; pocket_orb_state_t s; } map[] = {
        {"idle",      POCKET_ORB_IDLE},
        {"listening", POCKET_ORB_LISTENING},
        {"thinking",  POCKET_ORB_THINKING},
        {"speaking",  POCKET_ORB_SPEAKING},
        {"error",     POCKET_ORB_ERROR},
    };
    for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); i++) {
        int nlen = (int)strlen(map[i].name);
        if (nlen == vlen && memcmp(v, map[i].name, vlen) == 0) {
            ui_orb_set_state(map[i].s);
            return;
        }
    }
    ESP_LOGW(TAG, "unknown orb state in frame: %.*s", vlen, v);
}
