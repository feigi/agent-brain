// D-02: Envelope response structure
export interface Envelope<T> {
  data: T;
  meta: {
    count?: number;
    timing?: number;  // ms
    cursor?: string;
    has_more?: boolean;
  };
}
