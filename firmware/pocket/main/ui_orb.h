#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    POCKET_ORB_IDLE = 0,
    POCKET_ORB_LISTENING,
    POCKET_ORB_THINKING,
    POCKET_ORB_SPEAKING,
    POCKET_ORB_ERROR,
} pocket_orb_state_t;

/* Boot the AMOLED panel, LVGL, and the orb render task.
 * Safe to call once after Wi-Fi and ES8311 I2C are up (shares I2C_NUM_0). */
esp_err_t ui_orb_start(void);

/* Push a state change onto the LVGL task's queue. Non-blocking, coalesces.
 * Safe from any task / ISR-free context. */
void ui_orb_set_state(pocket_orb_state_t state);

/* Parse a text control frame from the bridge ("{\"orb\":\"listening\"}" etc.)
 * and apply it. Unknown names are logged and ignored. */
void ui_orb_apply_text_frame(const char *json, int len);

#ifdef __cplusplus
}
#endif
