/* tslint:disable */
/* eslint-disable */
export class WorldTokenizer {
  free(): void;
  constructor();
  encode(word: string): Uint16Array;
  encode_batch(word_list: string[]): Array<any>;
  decode(vec: Uint16Array): string;
  vocab_size(): number;
  get_vocab_as_json(): any;
}
