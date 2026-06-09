const CREATE_CUSTOMER_MOCK_URL = "https://example.com/";

export function buildCreateCustomerTaskUrl(customerName: string) {
  const url = new URL(CREATE_CUSTOMER_MOCK_URL);
  url.searchParams.set("task", "create-customer");
  url.searchParams.set("name", customerName);
  return url.toString();
}
