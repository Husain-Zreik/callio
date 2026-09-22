import { config } from "../../../config/envConfig.js";

export const notifyLog = (message, data = null) => {
    if (config.logging.enableNotificationLogs) {
        if (data) {
            console.log(`[Notification] ${message}`, data);
        } else {
            console.log(`[Notification] ${message}`);
        }
    }
};
