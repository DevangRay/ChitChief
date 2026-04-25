import ForbiddenError from "./custom_errors/ForbiddenError.js";

export enum PaymentMethod {
    "SUCCESS_VISA" = "pm_card_visa",
    "SUCCESS_VISA_DEBIT" = "pm_card_visa_debit",
    "SUCCESS_MASTERCARD" = "pm_card_mastercard",
    "AUTH_REQUIRED" = "pm_card_authenticationRequired",
    "FAIL_DECLINED" = "pm_card_visa_chargeDeclined",
    "FAIL_INSUFFICIENT_FUNDS" = "pm_card_visa_chargeDeclinedInsufficientFunds",
    "FAIL_CUSTOMER_CHARGED" = "pm_card_chargeCustomerFail"
}

export type PaymentMethodKey = keyof typeof PaymentMethod;

export function getStripePaymentMethodFromEnum(enum_method: string) {
    switch (enum_method) {
        case "SUCCESS_VISA":
            return PaymentMethod.SUCCESS_VISA;
        case "SUCCESS_VISA_DEBIT":
            return PaymentMethod.SUCCESS_VISA_DEBIT;
        case "SUCCESS_MASTERCARD":
            return PaymentMethod.SUCCESS_MASTERCARD;
        case "AUTH_REQUIRED":
            return PaymentMethod.AUTH_REQUIRED;
        case "FAIL_DECLINED":
            return PaymentMethod.FAIL_DECLINED;
        case "FAIL_INSUFFICIENT_FUNDS":
            return PaymentMethod.FAIL_INSUFFICIENT_FUNDS;
        case "FAIL_CUSTOMER_CHARGED":
            return PaymentMethod.FAIL_CUSTOMER_CHARGED;
        default:
            throw new ForbiddenError("Invalid payment method provided.");
    }
}