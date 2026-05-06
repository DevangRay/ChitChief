import "dotenv/config"; // Ensure environment variables are loaded
import { Resend } from 'resend';
import EmailError from './custom_errors/EmailError.js';

const resend = new Resend(process.env.RESEND_SECRET_KEY);

export async function sendPostPaymentEmail(order_was_successful: boolean, email_target: string[], order_id: string, event_name: string, seats: string[]) {
    let html_message, subject;
    if (order_was_successful) {
        subject = 'Order successfully processed'
        html_message = `<h1>Congratulations!</h1><p>Your order for seats ${seats.join(", ")} for ${event_name} has been confirmed.</p><p>For your records, your order confirmation number is: ${order_id}.</p>`
    } else {
        subject = 'Issue with your order'
        html_message = `<h1>Action needed</h1><p>Your order for seats ${seats.join(", ")} for ${event_name} could not be confirmed.</p><p>Please try purchasing again.</p>`
    }

    const { data, error } = await resend.emails.send({
        from: 'ChitChief <chitchief@devangray.dev>',
        to: email_target,
        subject: subject,
        html: html_message
    });

    if (error) {
        console.log("[sendPostPaymentEmail] Encountered error.")
        throw new EmailError("Encountered an error with sending an email.");
    }

    console.log("[sendPostPaymentEmail] Sent email with data:")
    console.log({ data })
    console.log("[sendPostPaymentEmail] Returning")
    return data;
}

export function formatSeats(row: string, number: number) {
    return `${row}${number}`
}